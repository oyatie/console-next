// SPDX-License-Identifier: LicenseRef-Proprietary
//! Canonical approval inbox; source records remain authoritative.
use crate::action_inbox::error::InboxError;
use axum::{
    Extension, Json, Router,
    extract::{Path, Query, State},
    routing::get,
};
use console_kernel_core::KernelError;
use console_platform_authz::Principal;
use serde::Deserialize;
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;
mod document;
mod org_change;
const BOXES: [&str; 5] = ["pending", "upcoming", "requested", "reference", "completed"];
#[derive(Deserialize)]
struct ListQuery {
    #[serde(rename = "box")]
    box_name: String,
    q: Option<String>,
    source: Option<String>,
    focus: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
}
pub fn router(pool: sqlx::PgPool, verifier: Option<console_platform_auth::JwtVerifier>) -> Router {
    console_platform_request_context::with_request_context(
        Router::new()
            .route("/api/v1/approvals", get(list))
            .route("/api/v1/approvals/{id}", get(document::get))
            .with_state(pool.clone()),
        verifier,
        pool,
    )
}
async fn list(
    State(pool): State<sqlx::PgPool>,
    Extension(principal): Extension<Principal>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, InboxError> {
    if !BOXES.contains(&q.box_name.as_str()) || !(1..=100).contains(&q.limit.unwrap_or(50)) {
        return Err(KernelError::validation("invalid approval query").into());
    }
    let after = q.cursor.as_deref().map(decode_cursor).transpose()?;
    let result = console_platform_db::with_org_locking_snapshot::<_, _, crate::error::AppError>(
        &pool,
        principal.org_id,
        move |tx| {
            Box::pin(async move {
                let visible = org_change::visible(tx, &principal)
                    .await
                    .map_err(|e| crate::error::AppError::Internal(e.to_string()))?;
                org_change::page(tx, principal.org_id, &q, after, visible)
                    .await
                    .map_err(|e| crate::error::AppError::Internal(e.to_string()))
            })
        },
    )
    .await
    .map_err(db)?;
    Ok(Json(result))
}
fn decode_cursor(value: &str) -> Result<(OffsetDateTime, Uuid), KernelError> {
    let parsed = value.split_once('~').and_then(|(stamp, id)| {
        Some((
            OffsetDateTime::from_unix_timestamp_nanos(stamp.parse().ok()?).ok()?,
            Uuid::parse_str(id).ok()?,
        ))
    });
    parsed.ok_or_else(|| KernelError::validation("invalid approval cursor"))
}

fn db(error: impl std::fmt::Display) -> KernelError {
    tracing::error!(error = %error, "approval projection unavailable");
    KernelError::internal("approval projection unavailable")
        .with_code("approvals.projection_unavailable")
}
