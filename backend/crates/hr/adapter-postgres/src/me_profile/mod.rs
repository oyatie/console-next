// SPDX-License-Identifier: LicenseRef-Proprietary
//! Self-service profile read, immediate update (`phone`, `emergency_contacts`),
//! passkey-step-up reveal, and approval-gated change-request filing (`address`,
//! boolean `bank_account_registered`) gated by Cedar `employee_self_read`.

mod reveal;
mod write;
pub use reveal::{SelfFieldRevealed, SelfRevealField, SelfRevealRequest};

use console_hr_domain::personal::EmergencyContactInput;
use console_hr_domain::profile::mask::{self, RevealField};
use console_kernel_core::{AuditAction, AuditEvent, TraceContext};
use console_platform_authz::Principal;
use console_platform_db::with_audits;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::certificates::self_service::require_self_employee;
use crate::{HrError, HrService};

#[derive(Debug, Clone, Serialize)]
pub struct SelfEmergencyContactSummary {
    pub name: String,
    pub relation: String,
    pub phone_masked: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SelfChangeRequestSummary {
    pub id: Uuid,
    pub field: String,
    pub status: String,
    pub masked_summary: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

#[derive(Debug, Clone, Serialize)]
pub struct MeProfileResponse {
    pub employee_id: Uuid,
    pub employee_number: Option<String>,
    pub org_unit: Option<String>,
    pub grade: Option<String>,
    pub position: Option<String>,
    pub hire_date: Option<String>,
    pub employment_status: String,
    pub phone_masked: Option<String>,
    pub emergency_contacts_registered: bool,
    pub emergency_contacts_count: i64,
    pub emergency_contacts: Vec<SelfEmergencyContactSummary>,
    pub address_masked: Option<String>,
    pub bank_account_registered: bool,
    pub open_change_requests: Vec<SelfChangeRequestSummary>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateMeProfileRequest {
    #[serde(default, deserialize_with = "deserialize_optional_string")]
    pub phone: Option<Option<String>>,
    #[serde(default)]
    pub emergency_contacts: Option<Vec<EmergencyContactInput>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SelfChangeRequestField {
    Address,
    BankAccountRegistered,
}

impl SelfChangeRequestField {
    pub(super) const fn as_str(self) -> &'static str {
        match self {
            Self::Address => "address",
            Self::BankAccountRegistered => "bank_account_registered",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateSelfChangeRequest {
    pub field: SelfChangeRequestField,
    #[serde(default)]
    pub address: Option<Value>,
    #[serde(default)]
    pub bank_account_registered: Option<bool>,
    #[serde(default)]
    pub note: Option<String>,
}

fn deserialize_optional_string<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

fn mask_address_change(value: &Value) -> Option<String> {
    let obj = value.as_object()?;
    let si = obj.get("si_nm").and_then(Value::as_str).unwrap_or("");
    let sgg = obj.get("sgg_nm").and_then(Value::as_str);
    let emd = obj.get("emd_nm").and_then(Value::as_str);
    Some(mask::address_dong(si, sgg, emd))
}

pub(super) async fn load_profile_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    user_id: Uuid,
    employee_id: Uuid,
) -> Result<MeProfileResponse, HrError> {
    let row = sqlx::query(
        r#"
        SELECT e.employee_number,
               COALESCE(NULLIF(btrim(ou.name), ''), NULLIF(btrim(e.org_unit), '')) AS org_unit,
               jt_grade.label AS grade,
               COALESCE(NULLIF(btrim(jt_pos.label), ''), NULLIF(btrim(e.position), '')) AS position,
               COALESCE(to_char(e.hire_on, 'YYYY-MM-DD'), NULLIF(btrim(e.hire_date), '')) AS hire_date,
               entity_employment_status_on(entity_today(), e.hire_on, e.exit_on, e.employment_status) AS employment_status,
               CASE WHEN console_employee_facts(e.org_id, e.id) ? 'phone'
                    THEN NULLIF(btrim(console_employee_facts(e.org_id, e.id)->>'phone'), '')
                    ELSE COALESCE(NULLIF(btrim(p.phone_e164), ''), NULLIF(btrim(u.phone), ''))
               END AS raw_phone,
               COALESCE(epf.bank_account_registered, FALSE) AS bank_account_registered,
               a.si_nm,
               a.sgg_nm,
               a.emd_nm
        FROM person_employees_current e
        LEFT JOIN users u ON u.org_id = e.org_id AND u.id = $3
        LEFT JOIN employee_employment_profiles p ON p.org_id = e.org_id AND p.employee_id = e.id
        LEFT JOIN employee_personal_facts epf ON epf.org_id = e.org_id AND epf.employee_id = e.id
        LEFT JOIN employee_register_facts erf ON erf.org_id = e.org_id AND erf.employee_id = e.id
        LEFT JOIN employee_addresses a ON a.org_id = erf.org_id AND a.id = erf.address_id
        LEFT JOIN LATERAL (
            SELECT r.attributes->>'name' AS name
            FROM org_unit_revisions r
            WHERE r.org_id = e.org_id AND r.org_unit_id = e.org_unit_id
            ORDER BY r.version DESC
            LIMIT 1
        ) ou ON e.org_unit_id IS NOT NULL
        LEFT JOIN job_titles jt_grade
               ON jt_grade.org_id = e.org_id AND jt_grade.id = e.grade_id AND jt_grade.kind = 'GRADE'
        LEFT JOIN job_titles jt_pos
               ON jt_pos.org_id = e.org_id AND jt_pos.id = e.job_title_id
        WHERE e.org_id = $1 AND e.id = $2
        "#,
    )
    .bind(org_id)
    .bind(employee_id)
    .bind(user_id)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| {
        HrError::from_kernel(console_kernel_core::KernelError::not_found(
            "employee record not found",
        ))
    })?;

    let raw_phone: Option<String> = row.try_get("raw_phone")?;
    let phone_masked = raw_phone
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|v| RevealField::Phone.masked(v));

    let contact_rows = sqlx::query(
        "SELECT name, relation, phone_e164 FROM employee_emergency_contacts \
         WHERE org_id = $1 AND employee_id = $2 AND voided_at IS NULL ORDER BY seq",
    )
    .bind(org_id)
    .bind(employee_id)
    .fetch_all(tx.as_mut())
    .await?;

    let emergency_contacts: Vec<SelfEmergencyContactSummary> = contact_rows
        .iter()
        .map(|c| {
            let phone_e164: String = c.try_get("phone_e164")?;
            Ok(SelfEmergencyContactSummary {
                name: c.try_get("name")?,
                relation: c.try_get("relation")?,
                phone_masked: RevealField::Phone.masked(&phone_e164),
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;

    let si_nm: Option<String> = row.try_get("si_nm")?;
    let sgg_nm: Option<String> = row.try_get("sgg_nm")?;
    let emd_nm: Option<String> = row.try_get("emd_nm")?;
    let address_masked = si_nm
        .as_deref()
        .map(|si| mask::address_dong(si, sgg_nm.as_deref(), emd_nm.as_deref()));

    let cr_rows = sqlx::query(
        "SELECT id, status, payload, created_at FROM change_requests \
         WHERE org_id = $1 AND kind = 'PROFILE_CORRECTION' \
           AND subject_type = 'EMPLOYEE' AND subject_id = $2 AND status = 'OPEN' \
         ORDER BY created_at DESC, id DESC",
    )
    .bind(org_id)
    .bind(employee_id)
    .fetch_all(tx.as_mut())
    .await?;

    let mut open_change_requests = Vec::new();
    for cr in cr_rows {
        let id: Uuid = cr.try_get("id")?;
        let status: String = cr.try_get("status")?;
        let payload: Value = cr.try_get("payload")?;
        let created_at: OffsetDateTime = cr.try_get("created_at")?;
        if let Some(changes) = payload.get("changes").and_then(Value::as_object) {
            for (field, val) in changes {
                let masked_summary = match field.as_str() {
                    "address" => mask_address_change(val),
                    "bank_account_registered" => match val.as_bool() {
                        Some(true) => Some("Registered".to_owned()),
                        Some(false) => Some("Not registered".to_owned()),
                        None => None,
                    },
                    other => RevealField::from_column(other).map(|reveal| {
                        let raw = val.as_str().map_or_else(|| val.to_string(), str::to_owned);
                        reveal.masked(&raw)
                    }),
                };
                open_change_requests.push(SelfChangeRequestSummary {
                    id,
                    field: field.clone(),
                    status: status.clone(),
                    masked_summary,
                    created_at,
                });
            }
        }
    }

    let emergency_contacts_count = i64::try_from(emergency_contacts.len()).unwrap_or(i64::MAX);
    Ok(MeProfileResponse {
        employee_id,
        employee_number: row.try_get("employee_number")?,
        org_unit: row.try_get("org_unit")?,
        grade: row.try_get("grade")?,
        position: row.try_get("position")?,
        hire_date: row.try_get("hire_date")?,
        employment_status: row.try_get("employment_status")?,
        phone_masked,
        emergency_contacts_registered: !emergency_contacts.is_empty(),
        emergency_contacts_count,
        emergency_contacts,
        address_masked,
        bank_account_registered: row.try_get("bank_account_registered")?,
        open_change_requests,
    })
}

pub(super) fn self_audit(
    principal: &Principal,
    action: &str,
    employee_id: Uuid,
    details: Value,
) -> Result<AuditEvent, HrError> {
    let mut after = details;
    if let Some(obj) = after.as_object_mut() {
        obj.insert("self_read".to_owned(), json!(true));
    }
    Ok(AuditEvent::new(
        Some(principal.user_id),
        AuditAction::new(action).map_err(HrError::from_kernel)?,
        "employee",
        employee_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(principal.org_id)
    .with_snapshots(None, Some(after)))
}

impl HrService {
    pub async fn get_me_profile(&self, principal: Principal) -> Result<MeProfileResponse, HrError> {
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        let user_uuid = *principal.user_id.as_uuid();
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let (_, employee_id) = require_self_employee(tx, &principal).await?;
                let profile = load_profile_in_tx(tx, org_uuid, user_uuid, employee_id).await?;
                let event = self_audit(
                    &principal,
                    "employee.self_profile_read",
                    employee_id,
                    json!({ "employee_id": employee_id }),
                )?;
                Ok((profile, vec![event]))
            })
        })
        .await
    }
}
