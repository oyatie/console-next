//! Account (de)activation: the ops account is never deactivated
//! (governance-22), nor is the caller's own account.

use crate::authz::authorize_org_manage;
use crate::context::principal_from_headers;
use crate::error::RestError;
use crate::policy::step_up::verify_step_up;
use crate::state::IdentityRestState;
use crate::users::authz::account_scope;
use crate::users::authz::refuse_ops_target;
use crate::users::dto::DeactivateUserRequest;
use axum::Json;
use axum::extract::Path;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use console_identity_application::ActivateUserCommand;
use console_identity_application::DeactivateUserCommand;
use console_kernel_core::TraceContext;
use console_kernel_core::UserId;
use console_platform_authz::Feature;
use time::OffsetDateTime;

pub(crate) async fn deactivate_user(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Path(id): Path<uuid::Uuid>,
    body: Option<Json<DeactivateUserRequest>>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let target_id = UserId::from_uuid(id);
    authorize_org_manage(&principal, Feature::UserManage)?;
    // Target must be within the caller's scope (IDOR).
    let target = state
        .store
        .get_user(target_id, &account_scope(&principal))
        .await
        .map_err(RestError::from_store)?;
    refuse_ops_target(target.is_tenant_ops)?;
    if target_id == principal.user_id {
        return Err(RestError::new(
            StatusCode::CONFLICT,
            "own_account_refused",
            "cannot deactivate your own account",
        ));
    }
    // Deactivation deletes every passkey of the target and ends their
    // sessions: a stolen bearer token alone must not lock people out (or
    // clear the way for a fresh sign-in code).
    verify_step_up(
        &state,
        &principal,
        body.and_then(|Json(body)| body.step_up),
        "deactivating an account requires a fresh passkey step-up",
    )
    .await?;
    let summary = state
        .store
        .deactivate_user(DeactivateUserCommand {
            actor: principal.user_id,
            user_id: target_id,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary))
}

pub(crate) async fn activate_user(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Path(id): Path<uuid::Uuid>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let target_id = UserId::from_uuid(id);
    if target_id == principal.user_id {
        return Err(RestError::bad_request("cannot activate your own account"));
    }
    authorize_org_manage(&principal, Feature::UserManage)?;
    // Target must be within the caller's scope (IDOR), including archived users.
    state
        .store
        .get_user(target_id, &account_scope(&principal))
        .await
        .map_err(RestError::from_store)?;
    let summary = state
        .store
        .activate_user(ActivateUserCommand {
            actor: principal.user_id,
            user_id: target_id,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary))
}
