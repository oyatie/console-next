// SPDX-License-Identifier: LicenseRef-Proprietary
//! Only usable, payload-bound exceptions are offered by the renewal picker.
use super::fixed_term::{FixedTermView, fixed_term_view};
use crate::authz::authorize_hr_org_wide;
use crate::clock::today_kst;
use crate::{HrError, HrService};
use console_hr_domain::lifecycle::fixed_term_exemption::FixedTermExemption;
use console_hr_domain::text::parse_yyyy_mm_dd;
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_org_conn;
use serde::Serialize;
use serde_json::json;
use sqlx::PgConnection;
use uuid::Uuid;

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
    /// `GET /api/v1/employees/{id}/fixed-term`: service as of today (KST).
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
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryRead)?;
        if contract_end_date.is_some() {
            authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        }
        let end = contract_end_date
            .as_deref()
            .map(parse_yyyy_mm_dd)
            .transpose()?
            .map(|d| d.to_string());
        let org = principal.org_id;
        let today = today_kst();
        with_org_conn::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let mut view = fixed_term_view(tx, *org.as_uuid(), employee_id, today).await?;
                view.available_exceptions = super::fixed_term_options::available(
                    tx.as_mut(),
                    *org.as_uuid(),
                    employee_id,
                    end.as_deref(),
                )
                .await?;
                Ok(view)
            })
        })
        .await
    }
}
