//! One HTTP intent -> one durable outcome. Only its business transaction says APPLIED.
use super::{RequestAuditContext, conflict};
mod execute;
mod response;
use axum::{
    body::{Body, to_bytes},
    extract::Request,
    middleware::Next,
    response::{IntoResponse, Response},
};
use console_kernel_core::{ActorKind, AuditCommandContext, AuditSource};
use console_platform_authz::Principal;
use console_platform_db::{
    command_context,
    command_outcomes::{self, Reservation},
    idempotency::validate_idempotency_key,
};
use http::{Method, StatusCode};
use response::{refusal, with_operation};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[derive(serde::Deserialize)]
struct SettingsPreviewQuery {
    #[serde(default)]
    dry_run: bool,
}

pub(crate) async fn run(
    pool: &PgPool,
    p: &Principal,
    transport: RequestAuditContext,
    request: Request,
    next: Next,
) -> Response {
    let mut audit = AuditCommandContext::for_actor(Some(p.user_id));
    audit.actor_kind = if p.support.is_some() {
        ActorKind::SupportOperator
    } else if p.is_tenant_ops {
        ActorKind::OpsAccount
    } else if p.access_scope.level == console_kernel_core::AccessScopeLevel::Group {
        ActorKind::GroupAdmin
    } else {
        ActorKind::TenantUser
    };
    audit.org_id = Some(p.org_id);
    audit.session_id = p
        .support
        .as_ref()
        .map(|s| s.session_id)
        .or(transport.session_id);
    audit.actor_display = p.support.as_ref().map(|s| s.operator_label.clone());
    audit.source = if request.headers().contains_key("sec-fetch-mode") {
        AuditSource::Form
    } else {
        AuditSource::Api
    };
    audit.scope_ids = vec![*p.org_id.as_uuid(), *p.access_scope.node_id.as_uuid()];
    audit.scope_ids.extend(
        request
            .uri()
            .path()
            .split('/')
            .filter_map(|v| Uuid::parse_str(v).ok()),
    );
    audit.scope_ids.sort();
    audit.scope_ids.dedup();
    audit.decision_snapshot.insert(
        "policy.active".into(),
        json!(p.authz_freshness.policy_version),
    );
    let writable = !matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    );
    // A settings preview claims no command; denied access is still audited.
    let settings_plan = request.method() == Method::POST
        && request
            .uri()
            .path()
            .strip_prefix("/api/v1/settings/")
            .is_some_and(|key| !key.is_empty() && !key.contains('/'))
        && axum::extract::Query::<SettingsPreviewQuery>::try_from_uri(request.uri())
            .is_ok_and(|query| query.dry_run);
    if !writable || settings_plan {
        return command_context::scope(audit, async {
            let response = next.run(request).await;
            if settings_plan && response.status() == StatusCode::FORBIDDEN {
                let (response, code) = response::refusal_code(response).await;
                if super::record_refusal(pool, p, &code, None).await.is_err() {
                    return refusal(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable", None);
                }
                return response;
            }
            response
        })
        .await;
    }
    let key = match request.headers().get("idempotency-key") {
        Some(value) => match value
            .to_str()
            .ok()
            .and_then(|s| validate_idempotency_key(Some(s)).ok())
        {
            Some(key) => key,
            None => {
                return command_context::scope(
                    audit.clone(),
                    audited_refusal(
                        pool,
                        p,
                        StatusCode::UNPROCESSABLE_ENTITY,
                        command_outcomes::INVALID_REQUEST_KEY_CODE,
                        None,
                    ),
                )
                .await;
            }
        },
        None => Uuid::new_v4().to_string(),
    };
    let representation = if request
        .headers()
        .get("prefer")
        .is_some_and(|v| v.as_bytes() == b"respond-async")
    {
        " [respond-async]"
    } else {
        ""
    };
    let command = format!(
        "{} {}{}",
        request.method(),
        request.uri().path(),
        representation
    );
    let query = request.uri().query().map(str::to_owned);
    let fallback = target(request.uri().path());
    let (parts, body) = request.into_parts();
    // The existing handler keeps its stricter body limit; capture itself is bounded.
    let bytes = match to_bytes(body, 64 * 1024 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
    };
    let mut fingerprint = fingerprint(&bytes);
    let query = query.unwrap_or_default();
    fingerprint.splice(
        ..0,
        query.len().to_be_bytes().into_iter().chain(query.bytes()),
    );
    let request = Request::from_parts(parts, Body::from(bytes));
    let outcome_reader = request
        .extensions()
        .get::<super::record_access::outcome::Reader>()
        .copied();
    let reserved = command_context::scope(
        audit.clone(),
        command_outcomes::reserve(
            pool,
            p.org_id,
            p.user_id,
            key,
            command,
            fingerprint,
            json!({"masked":true}),
        ),
    )
    .await;
    let id = match reserved {
        Ok(Reservation::Fresh(id)) => id,
        Ok(Reservation::Mismatch(id)) => {
            return command_context::scope(
                audit.clone(),
                audited_refusal(
                    pool,
                    p,
                    StatusCode::CONFLICT,
                    "idempotency_key_reused",
                    Some(id),
                ),
            )
            .await;
        }
        Ok(Reservation::Existing(mut out)) => {
            if out.state == "APPLIED"
                && super::record_access::outcome::readable(pool, p, &mut out, outcome_reader).await
                && let Some(mut result) = out.result
            {
                super::record_access::mask_saved_result(pool, p, &mut result).await;
                return with_operation(
                    response::replay(&out.command, out.response_status, result),
                    out.id,
                );
            }
            if out.state == "PROCESSING"
                && let Ok(Some(token)) =
                    command_outcomes::execution::claim(pool, p.org_id, out.id).await
            {
                audit.command_id = Some(out.id);
                return command_context::scope_execution(
                    audit.clone(),
                    Some(token),
                    execute::run(pool, p, transport, request, next, audit, out.id, fallback),
                )
                .await;
            }
            if out.state == "APPLIED"
                && out.result.is_none()
                && let Ok(Some(token)) =
                    command_outcomes::execution::resume_employee_routing(pool, p.org_id, out.id)
                        .await
            {
                audit.command_id = Some(out.id);
                return command_context::scope_execution(
                    audit.clone(),
                    Some(token),
                    execute::run(pool, p, transport, request, next, audit, out.id, fallback),
                )
                .await;
            }
            let code = if out.state == "PROCESSING" {
                command_outcomes::COMMAND_PROCESSING_CODE
            } else if out.state == "APPLIED" {
                command_outcomes::COMMAND_APPLIED_CODE
            } else {
                command_outcomes::COMMAND_SETTLED_CODE
            };
            return command_context::scope(
                audit.clone(),
                audited_refusal(pool, p, StatusCode::CONFLICT, code, Some(out.id)),
            )
            .await;
        }
        Err(_) => return refusal(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable", None),
    };
    audit.command_id = Some(id);
    let token = match command_outcomes::execution::claim(pool, p.org_id, id).await {
        Ok(Some(token)) => token,
        Ok(None) => {
            return refusal(
                StatusCode::CONFLICT,
                command_outcomes::COMMAND_PROCESSING_CODE,
                Some(id),
            );
        }
        Err(_) => {
            return refusal(
                StatusCode::SERVICE_UNAVAILABLE,
                "service_unavailable",
                Some(id),
            );
        }
    };
    command_context::scope_execution(
        audit.clone(),
        Some(token),
        execute::run(pool, p, transport, request, next, audit, id, fallback),
    )
    .await
}

pub fn fingerprint(bytes: &[u8]) -> Vec<u8> {
    let Ok(mut body) = serde_json::from_slice::<Value>(bytes) else {
        return bytes.to_vec();
    };
    if let Some(object) = body.as_object_mut() {
        object.remove("step_up");
    }
    body.sort_all_objects();
    serde_json::to_vec(&body).unwrap_or_else(|_| bytes.to_vec())
}
fn target(path: &str) -> Option<(String, String, Option<Uuid>)> {
    let parts: Vec<_> = path.split('/').filter(|s| !s.is_empty()).collect();
    let (kind, id) = match parts.as_slice() {
        ["api", "v1", "employees", id, ..] => ("employee", *id),
        ["api", "v1", "legal-entities", id, ..] => ("legal_entity", *id),
        ["api", "v1", "workplaces", id, ..] => ("workplace", *id),
        ["api", "v1", "org-units", id, ..] => ("org_unit", *id),
        ["api", "v1", "business-registrations", id, ..] => ("business_registration", *id),
        ["api", "v1", "org-changes", id, ..] => ("org_change_request", *id),
        _ => return None,
    };
    Uuid::parse_str(id).ok()?;
    Some((kind.into(), id.into(), None))
}
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;

async fn audited_refusal(
    pool: &PgPool,
    p: &Principal,
    status: StatusCode,
    code: &str,
    id: Option<Uuid>,
) -> Response {
    if super::record_refusal(pool, p, code, id).await.is_err() {
        return refusal(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable", id);
    }
    refusal(status, code, id)
}
