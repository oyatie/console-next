//! One writer for every audit context column, in the mutation's transaction.
use crate::{DbError, command_context};
use console_kernel_core::AuditEvent;
use sqlx::{Postgres, Transaction};

pub(crate) async fn insert_audit_event_tx(
    tx: &mut Transaction<'_, Postgres>,
    event: &AuditEvent,
) -> Result<(), DbError> {
    crate::command_outcomes::execution::bind(tx).await?;
    let mut context = match &event.command_context {
        Some(context) if context.admission_captured => context.clone(),
        _ => command_context::prepare(tx, event).await?,
    };
    if context.actor_display.is_none()
        && let Some(actor) = event.actor
    {
        context.actor_display = sqlx::query_scalar(
            "SELECT display_name FROM users WHERE id = $1 AND ($2::uuid IS NULL OR org_id=$2)",
        )
        .bind(actor.as_uuid())
        .bind(event.org_id.map(|id| *id.as_uuid()))
        .fetch_optional(tx.as_mut())
        .await?;
    }
    let decision = serde_json::to_value(&context.decision_snapshot)?;
    sqlx::query(r#"INSERT INTO audit_events (
        id, actor, action, target_type, target_id, branch_id, before_snap, after_snap,
        trace_id, span_id, occurred_at, org_id, ip, user_agent, auth_method, device,
        classification_badges, anomaly, reason, source, change_mode, reason_code,
        decision_snapshot, command_id, scope_ids, actor_kind, principal_type, session_id,
        outcome, actor_display, actor_employer, row_hash_version
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,2)"#)
        .bind(event.id.as_uuid()).bind(event.actor.map(|id| *id.as_uuid()))
        .bind(event.action.as_str()).bind(&event.target_type).bind(&event.target_id)
        .bind(event.branch_id.map(|id| *id.as_uuid())).bind(&event.before).bind(&event.after)
        .bind(event.trace.trace_id()).bind(event.trace.span_id()).bind(event.occurred_at)
        .bind(event.org_id.map(|id| *id.as_uuid())).bind(&event.request_context.ip)
        .bind(&event.request_context.user_agent).bind(&event.request_context.auth_method)
        .bind(&event.request_context.device).bind(&event.classification.badges)
        .bind(event.classification.anomaly).bind(&event.classification.reason)
        .bind(context.source.as_str()).bind(context.change_mode.map_or("DIRECT", |mode| mode.as_str()))
        .bind(&context.reason_code).bind(decision).bind(context.command_id).bind(&context.scope_ids)
        .bind(context.actor_kind.as_str()).bind(context.actor_kind.principal_type())
        .bind(context.session_id).bind(context.outcome.as_str()).bind(&context.actor_display)
        .bind(&context.actor_employer).execute(tx.as_mut()).await?;
    Ok(())
}
