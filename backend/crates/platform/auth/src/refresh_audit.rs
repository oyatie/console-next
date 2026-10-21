//! The audit row of a refresh-family event (rotation, reuse, logout, absolute
//! cap, idle end), on the refresh transaction.
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
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
    .with_snapshots(None, Some(after));

    // Stamp `org_id` on the row (the enclosing tx already armed `app.current_org`
    // to this org before the RLS-gated read). Omitting it lands the row with
    // NULL org_id — which the FORCE-RLS WITH CHECK still permits, but then a
    // tenant-scoped `/api/audit` read (RLS `USING (org_id = app.current_org)`)
    // can never see these refresh/logout events.
    sqlx::query(
        r#"
        INSERT INTO audit_events (
            id, actor, action, target_type, target_id, branch_id,
            before_snap, after_snap, trace_id, span_id, occurred_at, org_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        "#,
    )
    .bind(*event.id.as_uuid())
    .bind(event.actor.map(|actor| *actor.as_uuid()))
    .bind(event.action.as_str())
    .bind(event.target_type)
    .bind(event.target_id)
    .bind(event.branch_id.map(|branch| *branch.as_uuid()))
    .bind(event.before)
    .bind(event.after)
    .bind(event.trace.trace_id())
    .bind(event.trace.span_id())
    .bind(event.occurred_at)
    .bind(event.org_id.map(|org_id| *org_id.as_uuid()))
    .execute(tx.as_mut())
    .await?;

    Ok(())
}
