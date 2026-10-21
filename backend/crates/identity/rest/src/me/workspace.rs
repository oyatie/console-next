use crate::context::principal_from_headers;
use crate::error::RestError;
use crate::state::IdentityRestState;
use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use console_kernel_core::TraceContext;
use serde::Deserialize;
use serde::Serialize;
use time::OffsetDateTime;

// ---------------------------------------------------------------------------
// Console workspace layout handlers (any authenticated user; principal's row only)
// ---------------------------------------------------------------------------

/// Response for `GET /api/v1/me/workspace`. `layout` is an opaque, frontend-owned
/// JSON object (the console window/panel arrangement); the empty default is `{}`.
#[derive(Debug, Serialize)]
pub(crate) struct WorkspaceResponse {
    pub(crate) layout: serde_json::Value,
}

/// Body for `PUT /api/v1/me/workspace`. The `layout` is stored verbatim; the DB
/// enforces it is a JSON object within the size cap.
#[derive(Debug, Deserialize)]
pub(crate) struct WorkspaceUpsertRequest {
    pub(crate) layout: serde_json::Value,
}

pub(crate) async fn get_workspace(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let layout = state
        .store
        .get_workspace_layout(principal.user_id)
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(WorkspaceResponse { layout }))
}

pub(crate) async fn put_workspace(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Json(body): Json<WorkspaceUpsertRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    // Reject non-object payloads at the boundary with a clear 422 rather than
    // letting the DB CHECK surface as a generic 500. (The DB CHECK remains the
    // final backstop for size and shape.)
    if !body.layout.is_object() {
        return Err(RestError::validation("layout must be a JSON object"));
    }
    // Size cap at the boundary is the REAL enforcement: the DB CHECK uses
    // pg_column_size(), which measures the TOAST-COMPRESSED jsonb size and so
    // rejects far fewer payloads than a raw byte count. Guarding the serialized
    // length here returns a clean 422 (never a DB-CHECK 500); the CHECK
    // (pg_column_size <= 64KiB, migration 0098) is only a defense-in-depth backstop.
    if serde_json::to_vec(&body.layout).map_or(usize::MAX, |bytes| bytes.len()) > 64 * 1024 {
        return Err(RestError::validation("layout exceeds the maximum size"));
    }
    let layout = state
        .store
        .put_workspace_layout(
            principal.user_id,
            body.layout,
            TraceContext::generate(),
            OffsetDateTime::now_utc(),
        )
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(WorkspaceResponse { layout }))
}
