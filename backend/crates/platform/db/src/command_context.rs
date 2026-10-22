//! Request-scoped command facts shared by the HTTP boundary and transaction writer.
use crate::DbError;
use console_kernel_core::{AuditCommandContext, AuditEvent, ChangeMode};
use sqlx::{Postgres, Transaction};
use std::cell::RefCell;
use std::future::Future;

pub struct CommandContext {
    pub audit: AuditCommandContext,
    pub attempts: RefCell<Vec<AuditEvent>>,
    execution: Option<uuid::Uuid>,
}
tokio::task_local! { static CURRENT: CommandContext; }
pub async fn scope<F: Future>(audit: AuditCommandContext, work: F) -> F::Output {
    scope_execution(audit, None, work).await
}
pub async fn scope_execution<F: Future>(
    audit: AuditCommandContext,
    execution: Option<uuid::Uuid>,
    work: F,
) -> F::Output {
    CURRENT
        .scope(
            CommandContext {
                audit,
                execution,
                attempts: RefCell::new(Vec::new()),
            },
            work,
        )
        .await
}
pub fn execution() -> Option<uuid::Uuid> {
    CURRENT.try_with(|c| c.execution).ok().flatten()
}
pub fn current() -> Option<AuditCommandContext> {
    CURRENT.try_with(|c| c.audit.clone()).ok()
}
pub fn attempts() -> Vec<AuditEvent> {
    CURRENT
        .try_with(|c| c.attempts.borrow().clone())
        .unwrap_or_default()
}
pub fn remember(event: &AuditEvent) {
    let _ = CURRENT.try_with(|c| c.attempts.borrow_mut().push(event.clone()));
}

/// Capture admission facts before the mutation, under the transaction's tenant.
pub async fn prepare(
    tx: &mut Transaction<'_, Postgres>,
    event: &AuditEvent,
) -> Result<AuditCommandContext, DbError> {
    let mut context = for_event(
        current().unwrap_or_else(|| AuditCommandContext::for_actor(event.actor)),
        event,
    );
    if let Some(branch) = event.branch_id
        && !context.scope_ids.contains(branch.as_uuid())
    {
        context.scope_ids.push(*branch.as_uuid());
    }
    if let Some(org) = event.org_id {
        for (key, version) in super::audit_snapshot::default_versions() {
            context
                .decision_snapshot
                .entry(key.clone())
                .or_insert_with(|| version.clone());
        }
        if let Ok(target) = uuid::Uuid::parse_str(&event.target_id) {
            context.scope_ids.push(target);
        }
        // Raw audited transactions may not have armed the tenant yet.
        let bound: String = sqlx::query_scalar("SELECT COALESCE(NULLIF(current_setting('app.current_org',true),''),set_config('app.current_org',$1,true))")
            .bind(org.to_string()).fetch_one(tx.as_mut()).await?;
        if bound != org.to_string() {
            return Err(DbError::Sqlx(sqlx::Error::Protocol(
                "audit tenant does not match transaction".into(),
            )));
        }
        let (phase, parents, versions) =
            super::audit_snapshot::admission(tx, org, &context.scope_ids).await?;
        context.scope_ids.extend(parents);
        context.decision_snapshot.extend(versions);
        if !context.scope_ids.contains(org.as_uuid()) {
            context.scope_ids.push(*org.as_uuid());
        }
        if context.change_mode.is_none() {
            context.change_mode = Some(if phase.as_deref() == Some("SETUP") {
                ChangeMode::Setup
            } else {
                ChangeMode::Direct
            });
        }
    }
    if let Some(branch) = event.branch_id
        && !context.scope_ids.contains(branch.as_uuid())
    {
        context.scope_ids.push(*branch.as_uuid());
    }
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
    if event.action.as_str().ends_with(".refused")
        || event.action.as_str().ends_with(".denied")
        || event.action.as_str().ends_with("_refused")
    {
        context.outcome = console_kernel_core::AuditOutcome::Denied;
    }
    if context.reason_code.is_none() {
        context.reason_code = event
            .after
            .as_ref()
            .and_then(|v| v.get("reason_code"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);
    }
    context.admission_captured = true;
    Ok(context)
}

/// Event facts enrich the admission snapshot without rereading after mutation.
pub fn for_event(mut context: AuditCommandContext, event: &AuditEvent) -> AuditCommandContext {
    if let Some(explicit) = &event.command_context {
        context.source = explicit.source;
        context.change_mode = explicit.change_mode.or(context.change_mode);
        context.reason_code = explicit.reason_code.clone().or(context.reason_code);
        context.command_id = explicit.command_id.or(context.command_id);
        context.session_id = explicit.session_id.or(context.session_id);
        context.scope_ids.extend(&explicit.scope_ids);
        context
            .decision_snapshot
            .extend(explicit.decision_snapshot.clone());
        if explicit.actor_kind != console_kernel_core::ActorKind::TenantUser {
            context.actor_kind = explicit.actor_kind;
        }
        context.outcome = explicit.outcome;
        context.actor_display = explicit.actor_display.clone().or(context.actor_display);
        context.actor_employer = explicit.actor_employer.clone().or(context.actor_employer);
    }
    if let Some(branch) = event.branch_id {
        context.scope_ids.push(*branch.as_uuid());
    }
    context.scope_ids.sort();
    context.scope_ids.dedup();
    if let Some(code) = event
        .after
        .as_ref()
        .and_then(|v| v.get("reason_code"))
        .and_then(serde_json::Value::as_str)
    {
        context.reason_code = Some(code.to_owned());
    }
    if let Some(mode) = event
        .after
        .as_ref()
        .and_then(|v| v.get("change_mode"))
        .and_then(serde_json::Value::as_str)
    {
        context.change_mode = match mode {
            "SETUP" => Some(ChangeMode::Setup),
            "DIRECT" => Some(ChangeMode::Direct),
            "GOVERNED" => Some(ChangeMode::Governed),
            "SOLE_HOLDER" => Some(ChangeMode::SoleHolder),
            "MIGRATION" => Some(ChangeMode::Migration),
            _ => context.change_mode,
        };
    }
    if event.action.as_str().ends_with(".refused")
        || event.action.as_str().ends_with(".denied")
        || event.action.as_str().ends_with("_refused")
    {
        context.outcome = console_kernel_core::AuditOutcome::Denied;
    }
    context
}

pub(crate) async fn prepare_transaction(
    tx: &mut Transaction<'_, Postgres>,
    org: console_kernel_core::OrgId,
) -> Result<AuditCommandContext, DbError> {
    let seed = AuditEvent::new(
        None,
        console_kernel_core::AuditAction::new("command.apply").map_err(|_| {
            DbError::Sqlx(sqlx::Error::Protocol(
                "invalid internal audit action".into(),
            ))
        })?,
        "command",
        "transaction",
        console_kernel_core::TraceContext::generate(),
        time::OffsetDateTime::now_utc(),
    )
    .with_org(org);
    crate::command_context::prepare(tx, &seed).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use console_kernel_core::{AuditAction, TraceContext};

    #[test]
    fn explicit_session_id_survives_for_event() -> Result<(), Box<dyn std::error::Error>> {
        let inherited = uuid::Uuid::new_v4();
        let explicit = uuid::Uuid::new_v4();
        for session_id in [Some(explicit), None] {
            let mut context = AuditCommandContext::for_actor(None);
            context.session_id = Some(inherited);
            let mut event_context = AuditCommandContext::for_actor(None);
            event_context.session_id = session_id;
            let event = AuditEvent::new(
                None,
                AuditAction::new("auth.refresh")?,
                "auth_refresh_token_family",
                explicit.to_string(),
                TraceContext::generate(),
                time::OffsetDateTime::now_utc(),
            )
            .with_command_context(event_context);
            assert_eq!(
                for_event(context, &event).session_id,
                session_id.or(Some(inherited))
            );
        }
        Ok(())
    }
}
