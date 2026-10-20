//! The audit row of a refresh-family event (rotation, reuse, logout, absolute
//! cap, idle end), on the refresh transaction.
use console_kernel_core::{AuditAction, AuditEvent, AuditSource, OrgId, TraceContext, UserId};
use console_platform_db::insert_audit_event;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::AuthError;

pub(crate) async fn insert_audit_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: OrgId,
    user_id: Uuid,
    family_id: Uuid,
    action: &str,
    now: OffsetDateTime,
    after: serde_json::Value,
) -> Result<(), AuthError> {
    let event = AuditEvent::new(
        Some(UserId::from_uuid(user_id)),
        AuditAction::new(action)?,
        "auth_refresh_token_family",
        family_id.to_string(),
        TraceContext::generate(),
        now,
    )
    .with_org(org)
    .with_snapshots(None, Some(after))
    .with_source(AuditSource::System);

    // The shared writer stamps `org_id` (a tenant-scoped audit read cannot see
    // a NULL org) and the command context. Refresh is not a command, so
    // `app.audit_command` is unset and a raw insert would leave that context
    // NULL. Source is SYSTEM: rotation and logout are session machinery.
    insert_audit_event(tx, &event).await?;
    Ok(())
}
