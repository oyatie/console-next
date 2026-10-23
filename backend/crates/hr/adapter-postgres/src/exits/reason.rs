//! The 퇴직 사유 an exit report gives (EMP-UI 14): a BW-07 `exit_reason`
//! code, system or the tenant's active one, with the report's note when the
//! code requires one. Checked inside the report's transaction.

use console_kernel_core::OrgId;
use console_settings_domain::code_lists::{ReasonDomain, ValidReason};
use sqlx::{Postgres, Transaction};

use crate::HrError;
use crate::lifecycle::title_reason::validate_reason_code;

/// The trimmed code, or `None`; 422 `reason_code_invalid` /
/// `reason_note_required` keep their codes.
pub(super) async fn checked_exit_reason(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    code: Option<&str>,
    note: &str,
) -> Result<Option<ValidReason>, HrError> {
    let Some(code) = code.map(str::trim) else {
        return Ok(None);
    };
    validate_reason_code(tx.as_mut(), org, ReasonDomain::ExitReason, code, Some(note))
        .await
        .map(Some)
}

/// HR resolves a missing report reason or replaces it before the case takes effect.
pub(super) async fn confirmation_reason(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    context: &console_hr_domain::exits::case::ExitCaseContext,
    supplied: Option<&str>,
) -> Result<ValidReason, HrError> {
    let stored: Option<String> = sqlx::query_scalar(
        "SELECT exit_reason_code FROM employee_exit_cases WHERE org_id=$1 AND id=$2",
    )
    .bind(org.as_uuid())
    .bind(context.id)
    .fetch_one(tx.as_mut())
    .await?;
    let code = supplied.or(stored.as_deref()).ok_or_else(|| {
        super::guards::record_refusal(org, context.employee_id, "confirm", "exit_reason_required");
        HrError {
            refusals: Some(Box::new(
                serde_json::json!([{ "field": "exit_reason_code" }]),
            )),
            ..crate::lifecycle::title_reason::coded(
                console_kernel_core::KernelError::validation(
                    "an exit reason is required for HR confirmation",
                )
                .with_code("exit_reason_required")
                .with_field("exit_reason_code"),
            )
        }
    })?;
    validate_reason_code(
        tx.as_mut(),
        org,
        ReasonDomain::ExitReason,
        code.trim(),
        Some(&context.site_manager_note),
    )
    .await
}
