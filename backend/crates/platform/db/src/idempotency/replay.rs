//! Bridge an already committed legacy response into the revisitable ledger.
use crate::{command_context, command_outcomes};
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use serde_json::Value;
use sqlx::{Postgres, Transaction};
pub async fn settle(
    tx: &mut Transaction<'_, Postgres>,
    operation: &str,
    request: &Value,
    response: &Value,
) -> Result<(), sqlx::Error> {
    if matches!(
        operation,
        "employee.lifecycle.bulk" | "employee.correction.bulk"
    ) {
        let items = response
            .get("items")
            .or_else(|| response.get("rows"))
            .and_then(Value::as_array);
        if let Some(items) = items {
            for item in items {
                if let Some(employee) = item.get("employee_id").and_then(Value::as_str) {
                    record(tx, "employee", Some(employee), Some(response)).await?;
                }
            }
            return Ok(());
        }
    }
    let (kind, target) = match operation {
        "users.create" => ("user", response.get("id")),
        "employee.lifecycle.create" => (
            "employee",
            response
                .get("employee_id")
                .or_else(|| request.get("employee_id")),
        ),
        "period_lock.lock" => ("period_lock", response.get("id")),
        "hr.exit_case.create" => ("employee_exit_case", response.get("id")),
        "appointment_notice.issue" => ("appointment_notice", response.get("id")),
        _ => ("command_outcome", None),
    };
    let target = target.and_then(Value::as_str);
    record(tx, kind, target, Some(response)).await
}
/// Record a legacy success without rerunning its mutation or inventing a response.
pub async fn record(
    tx: &mut Transaction<'_, Postgres>,
    kind: &str,
    target: Option<&str>,
    response: Option<&Value>,
) -> Result<(), sqlx::Error> {
    let Some(context) = command_context::current().filter(|c| c.command_id.is_some()) else {
        return Ok(());
    };
    let id = context
        .command_id
        .ok_or_else(|| sqlx::Error::Protocol("missing command identity".into()))?;
    let (org, actor): (uuid::Uuid, uuid::Uuid) =
        sqlx::query_as("SELECT org_id,actor_id FROM command_outcomes WHERE id=$1")
            .bind(id)
            .fetch_one(tx.as_mut())
            .await?;
    if let Some(response) = response {
        command_outcomes::set_result(tx, response)
            .await
            .map_err(db_error)?;
    }
    let target = target.map_or_else(|| id.to_string(), str::to_owned);
    let event = AuditEvent::new(
        Some(UserId::from_uuid(actor)),
        AuditAction::new("command.replayed").map_err(|e| sqlx::Error::Protocol(e.to_string()))?,
        kind,
        target,
        TraceContext::generate(),
        time::OffsetDateTime::now_utc(),
    )
    .with_org(OrgId::from_uuid(org))
    .with_command_context(context)
    .with_snapshots(None, Some(serde_json::json!({"legacy_replay":true})));
    crate::insert_audit_event(tx, &event)
        .await
        .map_err(db_error)
}
fn db_error(error: crate::DbError) -> sqlx::Error {
    match error {
        crate::DbError::Sqlx(error) => error,
        _ => sqlx::Error::Protocol("command replay could not be recorded".into()),
    }
}
