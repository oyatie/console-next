//! IMPORT-2 (decisions #25): 사번 — numbering rules, a 사번 변경 (not a 정정:
//! an effective date, a reason code, the old number kept as an alias that
//! still finds the person, history), and bulk renumbering with an old → new
//! preview and a SETUP undo. Every reference stays on the UUID.

pub mod change;
pub mod facts;
pub mod renumber;
pub mod renumber_apply;
pub mod rules;

use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use serde_json::Value;
use time::OffsetDateTime;

use crate::HrError;

/// An audit event of this module (`target` is the employee or batch id).
pub(crate) fn audit(
    org: OrgId,
    actor: UserId,
    action: &str,
    target_type: &str,
    target: String,
    after: Value,
) -> Result<AuditEvent, HrError> {
    Ok(AuditEvent::new(
        Some(actor),
        AuditAction::new(action).map_err(HrError::from_kernel)?,
        target_type,
        target,
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(None, Some(after)))
}

pub(crate) fn coded(status: http::StatusCode, code: &'static str, message: &str) -> HrError {
    HrError {
        status,
        code,
        message: message.to_owned(),
        refusals: None,
    }
}

/// A reason code of the `employee_number_change` domain.
pub(crate) async fn check_reason(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: OrgId,
    code: &str,
    note: Option<&str>,
) -> Result<(), HrError> {
    console_settings_adapter_postgres::validate_reason_in_tx(
        tx.as_mut(),
        org,
        console_settings_domain::code_lists::ReasonDomain::EmployeeNumberChange,
        code,
        note,
    )
    .await
    .map(drop)
    .map_err(|error| {
        let code = error.code;
        let mut hr = HrError::from_kernel(error);
        if let Some(code) = code {
            hr.code = code;
        }
        hr
    })
}
