use crate::context::principal_from_headers;
use crate::error::RestError;
use crate::me::authz::me_authz_projection;
use crate::state::IdentityRestState;
use crate::users::dto::UpdateSelfRequest;
use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use console_identity_application::UpdateSelfProfileCommand;
use console_kernel_core::BranchScope;
use console_kernel_core::TraceContext;
use time::OffsetDateTime;

// ---------------------------------------------------------------------------
// Self-profile handlers (any authenticated user)
// ---------------------------------------------------------------------------

pub(crate) async fn get_me(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    // A user can always read their own record regardless of branch scope.
    let summary = state
        .store
        .get_user(principal.user_id, &BranchScope::All)
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary))
}

pub(crate) async fn update_me(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Json(body): Json<UpdateSelfRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let summary = state
        .store
        .update_self_profile(UpdateSelfProfileCommand {
            user_id: principal.user_id,
            display_name: body.display_name,
            phone: body.phone,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary))
}

pub(crate) async fn get_me_authz(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, RestError> {
    // The resolved Principal already carries the live branch scope + runtime
    // custom-role grants (armed under this request's org), so the projection is
    // pure — no DB read beyond principal resolution.
    let principal = principal_from_headers(&state, &headers).await?;
    Ok(Json(me_authz_projection(&principal)))
}
