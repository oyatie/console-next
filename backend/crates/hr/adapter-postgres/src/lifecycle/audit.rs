//! The system-actor audit the scheduled lifecycle runner writes (moved from
//! `app/src/hr.rs`, R2-life).

use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext};
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::HrError;

/// A system-actor audit for the scheduled-event runner.
pub(crate) fn scheduled_lifecycle_audit(
    org: OrgId,
    action: &'static str,
    employee_id: Uuid,
    after: Value,
) -> Result<AuditEvent, HrError> {
    Ok(AuditEvent::new(
        None,
        AuditAction::new(action).map_err(HrError::from_kernel)?,
        "employee",
        employee_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_source(console_kernel_core::AuditSource::Scheduler)
    .with_org(org)
    .with_snapshots(None, Some(after)))
}
