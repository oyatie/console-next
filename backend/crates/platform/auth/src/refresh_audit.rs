//! The audit row of a refresh-family event (rotation, reuse, logout, absolute
//! cap, idle end), on the refresh transaction.
use console_kernel_core::{
    AuditAction, AuditCommandContext, AuditEvent, AuditOutcome, AuditSource, OrgId, TraceContext,
    UserId,
};
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
    let event = audit_event(
        org,
        user_id,
        family_id,
        action,
        now,
        after,
        AuditOutcome::Allowed,
    )?;
    insert_audit_event(tx, &event).await?;
    Ok(())
}

pub(crate) async fn insert_refusal_audit_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: OrgId,
    user_id: Uuid,
    family_id: Uuid,
    action: &str,
    now: OffsetDateTime,
    after: serde_json::Value,
) -> Result<(), AuthError> {
    let event = audit_event(
        org,
        user_id,
        family_id,
        action,
        now,
        after,
        AuditOutcome::Denied,
    )?;
    insert_audit_event(tx, &event).await?;
    Ok(())
}

fn audit_event(
    org: OrgId,
    user_id: Uuid,
    family_id: Uuid,
    action: &str,
    now: OffsetDateTime,
    after: serde_json::Value,
    outcome: AuditOutcome,
) -> Result<AuditEvent, AuthError> {
    let mut ctx = AuditCommandContext::for_actor(Some(UserId::from_uuid(user_id)));
    ctx.source = AuditSource::System;
    ctx.session_id = Some(family_id);
    ctx.outcome = outcome;
    Ok(AuditEvent::new(
        Some(UserId::from_uuid(user_id)),
        AuditAction::new(action)?,
        "auth_refresh_token_family",
        family_id.to_string(),
        TraceContext::generate(),
        now,
    )
    .with_org(org)
    .with_snapshots(None, Some(after))
    .with_command_context(ctx))
}
