//! The exit-case audit event (moved from `app/src/hr.rs`, R2-exits).

use console_hr_domain::exits::case::ExitCaseContext;
use console_kernel_core::{AuditAction, AuditEvent, BranchId, OrgId, TraceContext, UserId};
use serde_json::Value;
use time::OffsetDateTime;

use crate::HrError;

pub fn exit_case_audit_event(
    actor: UserId,
    org: OrgId,
    action: &'static str,
    context: &ExitCaseContext,
    after: Value,
) -> Result<AuditEvent, HrError> {
    let mut event = AuditEvent::new(
        Some(actor),
        AuditAction::new(action).map_err(HrError::from_kernel)?,
        "employee_exit_case",
        context.id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(None, Some(after));
    if let Some(branch_id) = context.branch_id {
        event = event.with_branch(BranchId::from_uuid(branch_id));
    }
    Ok(event)
}
