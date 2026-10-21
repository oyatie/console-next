//! Revisitable, tenant-scoped command outcomes (BL-010).
use crate::http::error::ApiError;
use axum::http::StatusCode;
use axum::{
    Extension, Json, Router,
    extract::{Path, Query, State},
    routing::get,
};
use console_platform_auth::JwtVerifier;
use console_platform_authz::Principal;
use console_platform_authz::cedar_pbac::actions::command_outcome;
use console_platform_db::{command_outcomes, command_outcomes::CommandOutcome};
use console_platform_request_context::{record_access, with_request_context};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgPool;

mod recovery;
mod statutory;
pub(crate) use recovery::tick;
pub(crate) use statutory::read_outcome as read_filing_outcome;

pub const REQUEST_ROUTE_PATHS: &[&str] = &["/api/v1/requests", "/api/v1/requests/{key}"];
pub fn router(pool: PgPool, jwt: Option<JwtVerifier>) -> Router {
    with_request_context(
        Router::new()
            .route(REQUEST_ROUTE_PATHS[0], get(by_query))
            .route(REQUEST_ROUTE_PATHS[1], get(by_key))
            .with_state(pool.clone()),
        jwt,
        pool,
    )
}
#[derive(Deserialize)]
struct Lookup {
    idempotency_key: String,
}
async fn by_query(
    State(pool): State<PgPool>,
    Extension(p): Extension<Principal>,
    Query(q): Query<Lookup>,
) -> Result<Json<Value>, ApiError> {
    read(pool, p, q.idempotency_key).await
}
async fn by_key(
    State(pool): State<PgPool>,
    Extension(p): Extension<Principal>,
    Path(key): Path<String>,
) -> Result<Json<Value>, ApiError> {
    read(pool, p, key).await
}

async fn read(pool: PgPool, p: Principal, key: String) -> Result<Json<Value>, ApiError> {
    if command_outcomes::valid_lookup_key(&key).is_err() {
        console_platform_request_context::record_refusal(
            &pool,
            &p,
            command_outcomes::INVALID_REQUEST_KEY_CODE,
            None,
        )
        .await
        .map_err(|_| ApiError::internal("internal server error"))?;
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            command_outcomes::INVALID_REQUEST_KEY_CODE,
            "invalid request key",
        ));
    }
    command_outcomes::expire_abandoned(&pool, p.org_id)
        .await
        .map_err(|_| ApiError::internal("internal server error"))?;
    let missing = || {
        ApiError::new(
            StatusCode::NOT_FOUND,
            command_outcomes::REQUEST_NOT_FOUND_CODE,
            "request not found",
        )
    };
    let out = command_outcomes::lookup(&pool, p.org_id, p.user_id, key)
        .await
        .map_err(|_| ApiError::internal("internal server error"))?;
    let Some(out) = out else {
        console_platform_request_context::record_refusal(
            &pool,
            &p,
            command_outcomes::REQUEST_NOT_FOUND_CODE,
            None,
        )
        .await
        .map_err(|_| ApiError::internal("internal server error"))?;
        return Err(missing());
    };
    let mut out = out;
    let readable = statutory::read_outcome(&pool, &p, &mut out).await;
    let owner = out.actor_id == *p.user_id.as_uuid();
    if !command_outcome::decide(
        &p.user_id.to_string(),
        &p.org_id.to_string(),
        owner,
        readable,
    )
    .unwrap_or(false)
    {
        console_platform_request_context::record_refusal(
            &pool,
            &p,
            command_outcomes::REQUEST_NOT_FOUND_CODE,
            Some(out.id),
        )
        .await
        .map_err(|_| ApiError::internal("internal server error"))?;
        return Err(missing());
    }
    if let Some(result) = out.result.as_mut() {
        record_access::mask_saved_result(&pool, &p, result).await;
    }
    let out = masked_outcome(out, readable);
    Ok(Json(out))
}
fn masked_outcome(mut out: CommandOutcome, readable: bool) -> Value {
    if !readable {
        out.result = None;
        out.touched = json!([]);
    }
    let mut value = serde_json::to_value(out).unwrap_or_else(|_| json!({}));
    value["masked"] = json!(!readable);
    value
}
#[cfg(test)]
mod tests;
