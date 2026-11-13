//! One writer for every audit context column, in the mutation's transaction.
use crate::{DbError, command_context};
use console_kernel_core::{AuditCommandContext, AuditEvent, OrgId};
use sqlx::{Postgres, QueryBuilder, Transaction};
use std::collections::{BTreeMap, BTreeSet};

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
        context.actor_display = sqlx::query_scalar::<_, Option<String>>(
            "SELECT display_name FROM person_accounts_current WHERE id = $1 AND ($2::uuid IS NULL OR org_id=$2)",
        )
        .bind(actor.as_uuid())
        .bind(event.org_id.map(|id| *id.as_uuid()))
        .fetch_optional(tx.as_mut())
        .await?.flatten();
    }
    insert_rows(tx, std::slice::from_ref(event), &[context]).await
}

pub(crate) async fn insert_audit_events_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    events: &[AuditEvent],
) -> Result<(), DbError> {
    if events.is_empty() {
        return Ok(());
    }
    // Reject a foreign event before any row is written, including under a bypass role.
    if events
        .iter()
        .any(|event| event.org_id.is_some_and(|id| id != org))
    {
        return Err(DbError::Sqlx(sqlx::Error::Protocol(
            "audit tenant does not match transaction".into(),
        )));
    }
    // shortcut: global audits use per-row admission, batch when callers supply a tenant.
    if events.iter().any(|event| event.org_id.is_none()) {
        for event in events {
            insert_audit_event_tx(tx, event).await?;
        }
        return Ok(());
    }
    crate::command_outcomes::execution::bind(tx).await?;
    let mut contexts = Vec::with_capacity(events.len());
    for event in events {
        let context = match &event.command_context {
            Some(context) if context.admission_captured => context.clone(),
            _ => command_context::prepare(tx, event).await?,
        };
        contexts.push(context);
    }
    let actors: Vec<_> = events
        .iter()
        .zip(&contexts)
        .filter(|(_, context)| context.actor_display.is_none())
        .filter_map(|(event, _)| event.actor.map(|actor| *actor.as_uuid()))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    if !actors.is_empty() {
        let displays: BTreeMap<uuid::Uuid, Option<String>> = sqlx::query_as(
            "SELECT id, display_name FROM person_accounts_current WHERE org_id=$1 AND id=ANY($2)",
        )
        .bind(org.as_uuid())
        .bind(&actors)
        .fetch_all(tx.as_mut())
        .await?
        .into_iter()
        .collect();
        for (event, context) in events.iter().zip(&mut contexts) {
            if context.actor_display.is_none() {
                context.actor_display = event
                    .actor
                    .and_then(|actor| displays.get(actor.as_uuid()).cloned().flatten());
            }
        }
    }
    insert_rows(tx, events, &contexts).await
}

async fn insert_rows(
    tx: &mut Transaction<'_, Postgres>,
    events: &[AuditEvent],
    contexts: &[AuditCommandContext],
) -> Result<(), DbError> {
    // PostgreSQL's protocol accepts at most u16::MAX parameters; each row binds 31.
    const ROWS_PER_INSERT: usize = u16::MAX as usize / 31;
    for (events, contexts) in events
        .chunks(ROWS_PER_INSERT)
        .zip(contexts.chunks(ROWS_PER_INSERT))
    {
        let decisions = contexts
            .iter()
            .map(|context| serde_json::to_value(&context.decision_snapshot))
            .collect::<Result<Vec<_>, _>>()?;
        let mut query = QueryBuilder::<Postgres>::new(
            r#"INSERT INTO audit_events (
        id, actor, action, target_type, target_id, branch_id, before_snap, after_snap,
        trace_id, span_id, occurred_at, org_id, ip, user_agent, auth_method, device,
        classification_badges, anomaly, reason, source, change_mode, reason_code,
        decision_snapshot, command_id, scope_ids, actor_kind, principal_type, session_id,
        outcome, actor_display, actor_employer, row_hash_version
    ) "#,
        );
        query.push_values(
            events.iter().zip(contexts).zip(&decisions),
            |mut row, ((event, context), decision)| {
                row.push_bind(event.id.as_uuid())
                    .push_bind(event.actor.map(|id| *id.as_uuid()))
                    .push_bind(event.action.as_str())
                    .push_bind(&event.target_type)
                    .push_bind(&event.target_id)
                    .push_bind(event.branch_id.map(|id| *id.as_uuid()))
                    .push_bind(&event.before)
                    .push_bind(&event.after)
                    .push_bind(event.trace.trace_id())
                    .push_bind(event.trace.span_id())
                    .push_bind(event.occurred_at)
                    .push_bind(event.org_id.map(|id| *id.as_uuid()))
                    .push_bind(&event.request_context.ip)
                    .push_bind(&event.request_context.user_agent)
                    .push_bind(&event.request_context.auth_method)
                    .push_bind(&event.request_context.device)
                    .push_bind(&event.classification.badges)
                    .push_bind(event.classification.anomaly)
                    .push_bind(&event.classification.reason)
                    .push_bind(context.source.as_str())
                    .push_bind(context.change_mode.map_or("DIRECT", |mode| mode.as_str()))
                    .push_bind(&context.reason_code)
                    .push_bind(decision)
                    .push_bind(context.command_id)
                    .push_bind(&context.scope_ids)
                    .push_bind(context.actor_kind.as_str())
                    .push_bind(context.actor_kind.principal_type())
                    .push_bind(context.session_id)
                    .push_bind(context.outcome.as_str())
                    .push_bind(&context.actor_display)
                    .push_bind(&context.actor_employer)
                    .push("2");
            },
        );
        query.build().execute(tx.as_mut()).await?;
    }
    Ok(())
}
