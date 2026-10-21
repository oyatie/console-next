//! Complete the admitted attempt without reopening an already applied command.
use super::{
    RequestAuditContext, conflict,
    response::{patch_error, refusal, refusal_code, with_operation},
};
use axum::{
    body::{Body, to_bytes},
    extract::Request,
    middleware::Next,
    response::Response,
};
use console_kernel_core::{AuditAction, AuditCommandContext, AuditEvent, AuditOutcome};
use console_platform_authz::Principal;
use console_platform_db::{command_context, command_outcomes};
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[allow(clippy::too_many_arguments)]
pub(super) async fn run(
    pool: &PgPool,
    p: &Principal,
    transport: RequestAuditContext,
    request: Request,
    next: Next,
    audit: AuditCommandContext,
    id: Uuid,
    fallback: Option<(String, String, Option<Uuid>)>,
) -> Response {
    let path = request.uri().path().to_owned();
    let mut response = next.run(request).await;
    let status = response.status();
    let attempt = command_context::attempts().into_iter().find(|event| {
        !event.action.as_str().starts_with("auth.") && !event.action.as_str().contains("step_up")
    });
    if status == StatusCode::CONFLICT {
        let record = attempt
            .as_ref()
            .map(|e| {
                (
                    e.target_type.clone(),
                    e.target_id.clone(),
                    e.branch_id.map(|id| *id.as_uuid()),
                )
            })
            .or(fallback);
        let change = if let Some((kind, target, branch)) = record {
            conflict::last_change(pool, p, &kind, &target, branch)
                .await
                .unwrap_or_else(|_| conflict::redacted())
        } else {
            conflict::redacted()
        };
        response = patch_error(response, "last_change", change).await;
    }
    if status.is_client_error() {
        let (patched, code) = refusal_code(response).await;
        response = patched;
        let state = if code == "receipt_expired" {
            "EXPIRED"
        } else if status == StatusCode::CONFLICT {
            "CONFLICT"
        } else {
            "REFUSED"
        };
        let mut denied = audit.clone();
        denied.outcome = AuditOutcome::Denied;
        let trace = transport.trace.clone();
        let event = AuditEvent::new(
            Some(p.user_id),
            match AuditAction::new("command.refused") {
                Ok(action) => action,
                Err(_) => {
                    return refusal(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "service_unavailable",
                        Some(id),
                    );
                }
            },
            attempt
                .as_ref()
                .map_or("command_outcome", |e| e.target_type.as_str()),
            attempt
                .as_ref()
                .map_or_else(|| id.to_string(), |e| e.target_id.clone()),
            trace,
            time::OffsetDateTime::now_utc(),
        )
        .with_org(p.org_id)
        .with_request_context(transport.request.clone())
        .with_command_context(denied)
        .with_snapshots(None, Some(json!({"refusal_code":code})));
        if command_outcomes::settle_refused(pool, p.org_id, id, state.into(), code, event)
            .await
            .is_err()
        {
            return refusal(
                StatusCode::SERVICE_UNAVAILABLE,
                "service_unavailable",
                Some(id),
            );
        }
    }
    if status.is_client_error() {
        response = patch_error(response, "operation_id", json!(id)).await;
    }
    let (response, result, replay_status) = capture(response, &path).await;
    if command_outcomes::execution::finish(pool, p.org_id, id, result, replay_status)
        .await
        .is_err()
    {
        return refusal(
            StatusCode::SERVICE_UNAVAILABLE,
            "service_unavailable",
            Some(id),
        );
    }
    with_operation(response, id)
}

async fn capture(response: Response, path: &str) -> (Response, Option<Value>, Option<i16>) {
    let status = response.status();
    if !status.is_success() {
        return (response, None, None);
    }
    let replay_status = super::response::replay_status(status, path);
    if !response
        .headers()
        .get(http::header::CONTENT_TYPE)
        .is_some_and(|v| v.as_bytes().starts_with(b"application/json"))
    {
        return (response, None, Some(replay_status.as_u16() as i16));
    }
    let (parts, body) = response.into_parts();
    match to_bytes(body, 64 * 1024 * 1024).await {
        Ok(bytes) => {
            let result = serde_json::from_slice(&bytes).ok();
            (
                Response::from_parts(parts, Body::from(bytes)),
                result,
                Some(replay_status.as_u16() as i16),
            )
        }
        Err(_) => (
            refusal(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable", None),
            None,
            None,
        ),
    }
}
