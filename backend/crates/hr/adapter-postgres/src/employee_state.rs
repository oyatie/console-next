// SPDX-License-Identifier: LicenseRef-Proprietary
//! Ordinary profile writes serialize with exit and rehire; governed corrections bypass this gate.
use crate::HrError;
use console_kernel_core::KernelError;
use serde_json::json;
use sqlx::PgConnection;
use uuid::Uuid;

pub(crate) async fn require_editable(
    conn: &mut PgConnection,
    org: Uuid,
    employee: Uuid,
) -> Result<(), HrError> {
    let (status, exit_on): (String, Option<time::Date>) = sqlx::query_as(
        "SELECT employment_status,exit_on FROM employees WHERE org_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(org)
    .bind(employee)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| HrError::from_kernel(KernelError::not_found("employee not found")))?;
    if status == "EXITED" {
        let rule = crate::legal_rules::rule(
            conn,
            console_compliance_domain::statutory::codes::EMPLOYMENT_RECORD_RETENTION_YEARS,
            exit_on.unwrap_or_else(crate::clock::today_kst),
        )
        .await?;
        return Err(HrError {
            status: http::StatusCode::CONFLICT,
            code: "employee_exited_read_only",
            message: "a former employee's record can only be changed through a governed correction"
                .into(),
            errors: None,
            refusals: Some(Box::new(json!([{ "status":status,"rule":rule }]))),
        });
    }
    Ok(())
}
