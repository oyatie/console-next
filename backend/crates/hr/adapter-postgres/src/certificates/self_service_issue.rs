// SPDX-License-Identifier: LicenseRef-Proprietary
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use time::{Date, Month, OffsetDateTime};
use uuid::Uuid;

use super::self_service::{SelfIssueCertificateRequest, require_self_employee};
use super::{commands::audit, not_found, read::from_row, refused, settings, validation};
use crate::{HrError, HrService};
use console_platform_authz::Principal;
use console_platform_db::{
    idempotency::{
        IdempotencyClaim, claim_idempotency_key, complete_idempotency_key, validate_idempotency_key,
    },
    settings_read::resolve_in_tx,
    with_audits,
};
use console_settings_domain::{SettingKey, SettingValue};

fn missing() -> HrError {
    refused(
        http::StatusCode::CONFLICT,
        "certificate_facts_missing",
        "a requested employee fact is not recorded; correct the personnel card first",
    )
}

fn recorded(value: Option<String>) -> Result<String, HrError> {
    value.filter(|v| !v.trim().is_empty()).ok_or_else(missing)
}

fn anniversary(date: Date, years: i32) -> Result<Date, HrError> {
    let year = date.year().checked_add(years).ok_or_else(missing)?;
    Date::from_calendar_date(year, date.month(), date.day())
        .or_else(|_| Date::from_calendar_date(year, Month::February, 28))
        .map_err(|_| missing())
}

async fn snapshot_for_self(
    tx: &mut Transaction<'_, Postgres>,
    p: &Principal,
    employee_id: Uuid,
    b: &SelfIssueCertificateRequest,
) -> Result<(Uuid, Value), HrError> {
    // Query `person_employees_current` (security-invoker projection) so no raw
    // `employees.name` / `employees.birth_date` literal is introduced.
    let row = sqlx::query(concat!(
        "SELECT e.name, e.hire_on, e.exit_on, e.employment_status, e.voided_at, \
         e.job, e.position, e.birth_date::TEXT AS birth, \
         p.base_pay_won::TEXT AS wage, p.pay_unit, \
         ea.legal_entity_id, le.name AS issuer \
         FROM person_employees_current e \
         LEFT JOIN employee_employment_profiles p ON p.org_id = e.org_id AND p.employee_id = e.id ",
        crate::assignment_lateral!(),
        " LEFT JOIN LATERAL (SELECT r.name FROM legal_entity_revisions r \
           WHERE r.org_id = e.org_id AND r.legal_entity_id = ea.legal_entity_id \
             AND r.effective_from <= (now() AT TIME ZONE 'Asia/Seoul')::date \
           ORDER BY r.effective_from DESC, r.version DESC LIMIT 1) le ON TRUE \
         WHERE e.org_id = $1 AND e.id = $2",
    ))
    .bind(p.org_id.as_uuid())
    .bind(employee_id)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(not_found)?;

    // Lock the underlying employee row in `employees` without selecting `name`/`birth_date`.
    sqlx::query("SELECT 1 FROM employees WHERE org_id = $1 AND id = $2 FOR SHARE")
        .bind(p.org_id.as_uuid())
        .bind(employee_id)
        .fetch_optional(tx.as_mut())
        .await?
        .ok_or_else(not_found)?;

    let entity = row
        .try_get::<Option<Uuid>, _>("legal_entity_id")?
        .ok_or_else(missing)?;
    let issuer = recorded(row.try_get("issuer")?)?;
    let now: OffsetDateTime = sqlx::query_scalar("SELECT now()")
        .fetch_one(tx.as_mut())
        .await?;
    let today = now.to_offset(time::macros::offset!(+9)).date();
    let hire: Date = row
        .try_get::<Option<Date>, _>("hire_on")?
        .ok_or_else(missing)?;
    let exit: Option<Date> = row.try_get("exit_on")?;
    let status: String = row.try_get("employment_status")?;
    let voided: Option<OffsetDateTime> = row.try_get("voided_at")?;
    if voided.is_some()
        || hire > today
        || !matches!(status.as_str(), "ACTIVE" | "ON_LEAVE" | "EXITED")
        || (b.kind == "EMPLOYMENT" && status == "EXITED")
        || (b.kind == "EXIT" && status != "EXITED")
    {
        return Err(refused(
            http::StatusCode::CONFLICT,
            "certificate_ineligible",
            "employee status does not support the requested certificate",
        ));
    }
    if status == "EXITED" {
        let end = exit.ok_or_else(missing)?;
        if end > today || end < hire {
            return Err(missing());
        }
        let key = SettingKey::RetentionLaborEmployeeRegister;
        let settings = resolve_in_tx(tx.as_mut(), p.org_id, &[key], Some(entity), now).await?;
        let years = match settings
            .get(&key)
            .and_then(|r| r.as_ref().ok())
            .map(|r| r.value)
        {
            Some(SettingValue::Int(years)) => i32::try_from(years).map_err(|_| missing())?,
            _ => return Err(missing()),
        };
        if today > anniversary(end, years)? {
            return Err(refused(
                http::StatusCode::CONFLICT,
                "certificate_retention_expired",
                "employee record is outside its configured retention window",
            ));
        }
    }
    let mut facts = json!({
        "name": row.try_get::<String, _>("name")?,
        "issuer": issuer,
    });
    for field in &b.items {
        facts[field] = match field.as_str() {
            "period" => {
                let to = if status == "EXITED" {
                    exit.ok_or_else(missing)?.to_string()
                } else {
                    today.to_string()
                };
                json!({ "from": hire.to_string(), "to": to })
            }
            "duty" => json!(recorded(row.try_get("job")?)?),
            "position" => json!(recorded(row.try_get("position")?)?),
            "birth" => json!(recorded(row.try_get("birth")?)?),
            "wage" => {
                json!({
                    "won": recorded(row.try_get("wage")?)?,
                    "unit": recorded(row.try_get("pay_unit")?)?,
                })
            }
            _ => return Err(super::invalid("unknown requested fact")),
        };
    }
    Ok((entity, facts))
}

impl HrService {
    pub async fn issue_my_certificate(
        &self,
        p: Principal,
        key: Option<String>,
        body: SelfIssueCertificateRequest,
    ) -> Result<Value, HrError> {
        if p.support.is_some() {
            return Err(refused(
                http::StatusCode::FORBIDDEN,
                "support_session_read_only",
                "support sessions cannot issue self-service certificates",
            ));
        }
        validation::issue_fields(&body.kind, &body.items, &body.purpose)?;
        let key = validate_idempotency_key(key.as_deref()).map_err(HrError::validation)?;
        with_audits::<_, _, HrError>(&self.pool, p.org_id, move |tx| {
            Box::pin(async move {
                let (_, employee_id) = require_self_employee(tx, &p).await?;
                let fingerprint = json!({
                    "actor": p.user_id,
                    "employee_id": employee_id,
                    "body": body,
                });
                match claim_idempotency_key(tx, "certificate.issue", &key, &fingerprint).await? {
                    IdempotencyClaim::Replay(response) => return Ok((response, vec![])),
                    IdempotencyClaim::Mismatch => {
                        return Err(crate::idempotency::idempotency_key_reused());
                    }
                    IdempotencyClaim::Fresh => {}
                }
                let (entity, mut snapshot) = snapshot_for_self(tx, &p, employee_id, &body).await?;
                let settings = settings::load(tx, *p.org_id.as_uuid(), entity).await?;
                snapshot["seal_text"] = json!(settings.seal_text);
                let year: i32 = sqlx::query_scalar(
                    "SELECT EXTRACT(YEAR FROM now() AT TIME ZONE 'Asia/Seoul')::integer",
                )
                .fetch_one(tx.as_mut())
                .await?;
                sqlx::query(
                    "SELECT pg_advisory_xact_lock(hashtext($1::text || ':certificate:' || $2::text || ':' || $3::text))",
                )
                .bind(p.org_id.as_uuid())
                .bind(entity)
                .bind(year)
                .execute(tx.as_mut())
                .await?;
                let seq: i64 = sqlx::query_scalar(
                    "SELECT COALESCE(max(seq),0)+1 FROM hr_certificates \
                     WHERE org_id = $1 AND (legal_entity_id = $3 OR legal_entity_id IS NULL) \
                       AND certificate_year = $2",
                )
                .bind(p.org_id.as_uuid())
                .bind(year)
                .bind(entity)
                .fetch_one(tx.as_mut())
                .await?;
                let width = usize::try_from(settings.width)
                    .map_err(|_| HrError::internal("invalid stored certificate width"))?;
                if seq.to_string().len() > width {
                    return Err(refused(
                        http::StatusCode::CONFLICT,
                        "certificate_numbers_exhausted",
                        "configured certificate number width is exhausted; increase it in settings",
                    ));
                }
                let number = format!("{}-{year}-{seq:0width$}", settings.prefix);
                let row = sqlx::query(
                    "INSERT INTO hr_certificates(org_id, employee_id, certificate_year, seq, \
                     certificate_no, kind, items, purpose, snapshot, replaces_id, issued_by, \
                     seal_id, legal_entity_id) \
                     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10,$11,$12) RETURNING *",
                )
                .bind(p.org_id.as_uuid())
                .bind(employee_id)
                .bind(year)
                .bind(seq)
                .bind(number)
                .bind(&body.kind)
                .bind(&body.items)
                .bind(body.purpose.trim())
                .bind(snapshot)
                .bind(p.user_id.as_uuid())
                .bind(settings.seal_id)
                .bind(entity)
                .fetch_one(tx.as_mut())
                .await?;
                let cert = from_row(&row)?;
                let audit = audit(
                    &p,
                    "certificate.self_issue",
                    cert.id,
                    json!({
                        "self_read": true,
                        "employee_id": cert.employee_id,
                        "certificate_no": cert.certificate_no,
                    }),
                )?;
                let response = json!(cert);
                complete_idempotency_key(tx, "certificate.issue", &key, &response).await?;
                Ok((response, vec![audit]))
            })
        })
        .await
    }
}
