//! The 퇴직 사유 an exit report gives (EMP-UI 14): a BW-07 `exit_reason`
//! code, system or the tenant's active one, with the report's note when the
//! code requires one. Checked inside the report's transaction.

use console_kernel_core::OrgId;
use console_settings_domain::code_lists::ReasonDomain;
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
) -> Result<Option<String>, HrError> {
    let Some(code) = code.map(str::trim) else {
        return Ok(None);
    };
    validate_reason_code(tx, org, ReasonDomain::ExitReason, code, Some(note)).await?;
    Ok(Some(code.to_owned()))
}
