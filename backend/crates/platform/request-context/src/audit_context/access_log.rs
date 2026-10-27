//! 접속기록 rows for 취급자 reads of personal data (INF-02, GOV-PEO-1), shared
//! by every module that serves such a read.
//!
//! 고시 2023-6 §2제3호 lists what a 접속기록 holds: 식별자 (`actor`), 접속일시
//! (`occurred_at`), 접속지 (the trusted client IP, from the request context),
//! 처리한 정보주체 (`subject_ids`) and 수행업무 (the action). §8① has no
//! 정보주체 exclusion, so a 취급자 reading their own record is logged too,
//! marked `self_read` for the review criteria to skip. The caller writes the
//! event in the read's own transaction (`with_audits`), or before the response
//! leaves when the read has none, so a read whose record fails returns nothing.

use console_kernel_core::{AccessScopeLevel, AuditAction, AuditEvent, KernelError, TraceContext};
use console_platform_authz::Principal;
use console_platform_db::{DbError, with_audit};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::current_audit_context;

/// One read to record.
#[derive(Debug)]
pub struct AccessRecord<'a> {
    /// 수행업무, e.g. `employee.read`.
    pub action: &'static str,
    pub target_type: &'static str,
    /// The read object's id, or `query` for a list.
    pub target_id: String,
    /// The 정보주체 shown, in one id space (employee ids or user ids). A
    /// whole-population read (export, org chart) passes none and names its
    /// row count in `details` instead.
    pub subject_ids: &'a [Uuid],
    /// The reader's own id in that same id space, if any (marks `self_read`).
    pub reader_subject: Option<Uuid>,
    /// Kind-specific fields (export 용도, row counts); ids and codes only.
    pub details: Value,
}

/// `principal_type` for a tenant route: a group admin acting in a delegated
/// tenant context, the tenant's own user, or a tenant-approved support principal.
fn principal_type(principal: &Principal) -> &'static str {
    if principal.support.is_some() {
        "SUPPORT_OPERATOR"
    } else if principal.access_scope.level == AccessScopeLevel::Group {
        "GROUP_ADMIN"
    } else {
        "TENANT_USER"
    }
}

/// Build the 접속기록 event. The trace, 접속지 (IP), user agent and the
/// bearer's session family come from the request context bound by
/// `with_request_context`; outside an HTTP request they are absent.
pub fn access_event(
    principal: &Principal,
    record: AccessRecord<'_>,
) -> Result<AuditEvent, KernelError> {
    let AccessRecord {
        action,
        target_type,
        target_id,
        subject_ids,
        reader_subject,
        details,
    } = record;
    let self_read = reader_subject
        .is_some_and(|me| !subject_ids.is_empty() && subject_ids.iter().all(|id| *id == me));
    let context = current_audit_context();
    let mut after = json!({
        "subject_ids": subject_ids,
        "subject_count": subject_ids.len(),
        "self_read": self_read,
        "principal_type": principal_type(principal),
        // GOV-AUD-1 promotes this and principal_type to audit_events columns.
        "session_id": context.as_ref().and_then(|context| context.session_id),
    });
    if let (Some(after), Value::Object(extra)) = (after.as_object_mut(), details) {
        after.extend(extra);
    }
    let trace = context
        .as_ref()
        .map_or_else(TraceContext::generate, |context| context.trace.clone());
    let mut event = AuditEvent::new(
        Some(principal.user_id),
        AuditAction::new(action)?,
        target_type,
        target_id,
        trace,
        OffsetDateTime::now_utc(),
    )
    .with_org(principal.org_id)
    .with_snapshots(None, Some(after));
    if let Some(context) = context {
        event = event.with_request_context(context.request);
    }
    Ok(event)
}

/// Commit a read's access record before its response leaves the server.
/// Reads already using `with_audits` keep the event in their own transaction.
pub async fn record_access(
    pool: &PgPool,
    principal: &Principal,
    record: AccessRecord<'_>,
) -> Result<(), DbError> {
    let event = access_event(principal, record)
        .map_err(|error| DbError::Sqlx(sqlx::Error::Protocol(error.to_string())))?;
    with_audit(pool, event, |_tx| Box::pin(async { Ok(()) })).await
}
