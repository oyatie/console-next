//! Negative command/read evidence without retaining attempted input values.
use console_kernel_core::{
    AuditAction, AuditCommandContext, AuditEvent, AuditOutcome, TraceContext,
};
use console_platform_authz::Principal;
use console_platform_db::DbError;
use sqlx::PgPool;
use uuid::Uuid;
pub async fn record_refusal(
    pool: &PgPool,
    p: &Principal,
    code: &str,
    command: Option<Uuid>,
) -> Result<(), DbError> {
    let transport = super::current_audit_context();
    let mut context = console_platform_db::command_context::current()
        .unwrap_or_else(|| AuditCommandContext::for_actor(Some(p.user_id)));
    context.command_id = command;
    context.outcome = AuditOutcome::Denied;
    let event = AuditEvent::new(
        Some(p.user_id),
        AuditAction::new("command.refused")
            .map_err(|e| DbError::Sqlx(sqlx::Error::Protocol(e.to_string())))?,
        "command_outcome",
        command.map_or_else(|| "lookup".into(), |id| id.to_string()),
        transport
            .as_ref()
            .map_or_else(TraceContext::generate, |t| t.trace.clone()),
        time::OffsetDateTime::now_utc(),
    )
    .with_org(p.org_id)
    .with_command_context(context)
    .with_snapshots(None, Some(serde_json::json!({"refusal_code":code})));
    let event = transport.map_or(event.clone(), |t| event.with_request_context(t.request));
    console_platform_db::with_org_conn(pool, p.org_id, move |tx| {
        Box::pin(async move { console_platform_db::insert_audit_event(tx, &event).await })
    })
    .await
}
