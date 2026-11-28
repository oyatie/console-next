// SPDX-License-Identifier: LicenseRef-Proprietary
//! Only usable, payload-bound exceptions are offered by the renewal picker.
use super::fixed_term::{FixedTermView, fixed_term_view};
use crate::clock::today_kst;
use crate::directory::access_log::lookup_event;
use crate::{HrError, HrService};
use console_compliance_domain::statutory::codes;
use console_hr_domain::lifecycle::fixed_term_exemption::FixedTermExemption;
use console_hr_domain::text::parse_yyyy_mm_dd;
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use serde::Serialize;
use serde_json::json;
use sqlx::PgConnection;
use time::Date;
use uuid::Uuid;

pub(super) async fn limit_months(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: Uuid,
    employee: Uuid,
    on: Date,
) -> Result<u8, HrError> {
    let rows: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT unit, value_num, value_den FROM statutory_rules \
         WHERE code = $1 AND effective_from <= $2 \
           AND (effective_to_exclusive IS NULL OR effective_to_exclusive > $2)",
    )
    .bind(codes::FIXED_TERM_MAX_YEARS)
    .bind(on)
    .fetch_all(tx.as_mut())
    .await?;
    let statutory_months = match rows.as_slice() {
        [(unit, years, 1)] if unit == "YEARS" => u8::try_from(years * 12)
            .map_err(|_| HrError::internal("fixed-term limit out of range"))?,
        _ => {
            return Err(HrError::internal(format!(
                "no single whole-year {} rule in force on {on}",
                codes::FIXED_TERM_MAX_YEARS
            )));
        }
    };
    let as_of = on
        .with_time(time::macros::time!(23:59:59.999999))
        .assume_offset(time::macros::offset!(+9));
    let key = console_settings_domain::SettingKey::HrFixedTermLimitMonths;
    let mut resolved = console_settings_adapter_postgres::resolve_in_tx(
        tx.as_mut(),
        console_kernel_core::OrgId::from_uuid(org),
        &[key],
        Some(employee),
        as_of,
    )
    .await
    .map_err(HrError::from_kernel)?;
    let policy_months = resolved
        .remove(&key)
        .and_then(Result::ok)
        .filter(|r| {
            matches!(
                r.version,
                console_kernel_core::SettingVersionId::Override(_)
            )
        })
        .and_then(|r| r.value.as_int())
        .and_then(|m| u8::try_from(m).ok())
        .unwrap_or(statutory_months);
    Ok(policy_months.clamp(1, statutory_months))
}

#[derive(Debug, Serialize)]
pub struct FixedTermExceptionOption {
    pub id: Uuid,
    pub ground_code: String,
    pub basis: &'static str,
    pub note: Option<String>,
}

pub(super) async fn available(
    conn: &mut PgConnection,
    org: Uuid,
    employee: Uuid,
    end: Option<&str>,
) -> Result<Vec<FixedTermExceptionOption>, HrError> {
    let Some(end) = end else {
        return Ok(Vec::new());
    };
    let rows: Vec<(Uuid, String, Option<String>)> = sqlx::query_as(
        "SELECT id, reason_code, note FROM governed_exceptions \
         WHERE org_id=$1 AND subject_type='EMPLOYEE' AND subject_id=$2 \
           AND rule_code='FIXED_TERM_OVER_TWO_YEARS' AND status IN ('RECORDED','APPROVED') \
           AND consumed_at IS NULL AND expires_at > now() \
           AND fingerprint=governed_exception_fingerprint($3, '{}'::daterange[]) \
         ORDER BY created_at DESC, id DESC",
    )
    .bind(org)
    .bind(employee)
    .bind(json!({"employee_id": employee, "contract_end_date": end}))
    .fetch_all(conn)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, ground_code, note)| {
            FixedTermExemption::ALL
                .iter()
                .find(|g| g.code() == ground_code)
                .map(|g| FixedTermExceptionOption {
                    id,
                    ground_code: ground_code.clone(),
                    basis: g.article(),
                    note,
                })
        })
        .collect())
}

impl HrService {
    /// `GET /api/v1/employees/{id}/fixed-term`: service as of today (KST),
    /// read as a lookup of that employee.
    pub async fn employee_fixed_term(
        &self,
        principal: Principal,
        employee_id: Uuid,
    ) -> Result<FixedTermView, HrError> {
        self.employee_fixed_term_for_renewal(principal, employee_id, None)
            .await
    }

    pub async fn employee_fixed_term_for_renewal(
        &self,
        principal: Principal,
        employee_id: Uuid,
        contract_end_date: Option<String>,
    ) -> Result<FixedTermView, HrError> {
        let org = principal.org_id;
        let today = today_kst();
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let features: &[Feature] = if contract_end_date.is_some() {
                    &[
                        Feature::EmployeeDirectoryRead,
                        Feature::EmployeeDirectoryManage,
                    ]
                } else {
                    &[Feature::EmployeeDirectoryRead]
                };
                super::action_refusals::require_tenant_permissions(tx, &principal, features)
                    .await?;
                let end = contract_end_date
                    .as_deref()
                    .map(parse_yyyy_mm_dd)
                    .transpose()?
                    .map(|d| d.to_string());
                let mut view = fixed_term_view(tx, *org.as_uuid(), employee_id, today).await?;
                view.available_exceptions = super::fixed_term_options::available(
                    tx.as_mut(),
                    *org.as_uuid(),
                    employee_id,
                    end.as_deref(),
                )
                .await?;
                let event = lookup_event(tx, &principal, employee_id, "fixed_term").await?;
                Ok((view, vec![event]))
            })
        })
        .await
    }
}
