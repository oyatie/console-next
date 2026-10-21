//! 아이디 변경 and history (decisions #33; sign-in-identifier.md §7): a
//! `user_manage` holder over the account, a reason, a 기준일, an audit row;
//! the old 아이디 stays an alias and is never reissued. No passkey step-up: a
//! rename grants and removes nothing (the passkeys stay bound to the UUID).

use crate::authz::authorize_org_manage;
use crate::context::principal_from_headers;
use crate::error::RestError;
use crate::state::IdentityRestState;
use crate::users::authz::account_scope;
use axum::Json;
use axum::extract::Path;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use console_identity_adapter_postgres::sign_in_id::{SignInIdChange, parse_login};
use console_kernel_core::UserId;
use console_platform_authz::Feature;
use serde::Deserialize;
use time::Date;
use time::macros::format_description;

/// Body of `POST /api/v1/users/{id}/sign-in-id`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ChangeSignInIdRequest {
    /// The new 아이디 (the part before `@`).
    pub(crate) login: String,
    /// `YYYY-MM-DD`, today or earlier.
    pub(crate) effective_date: String,
    pub(crate) reason_code: String,
    #[serde(default)]
    pub(crate) note: Option<String>,
}

pub(crate) async fn change_sign_in_id(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Path(id): Path<uuid::Uuid>,
    Json(body): Json<ChangeSignInIdRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage(&principal, Feature::UserManage)?;
    let target = UserId::from_uuid(id);
    // The account must be inside the caller's account scope (IDOR): 404 else.
    state
        .store
        .get_user(target, &account_scope(&principal))
        .await
        .map_err(RestError::from_store)?;
    let login = parse_login(&body.login).map_err(RestError::from_store)?;
    let effective_date = Date::parse(
        body.effective_date.trim(),
        format_description!("[year]-[month]-[day]"),
    )
    .map_err(|_| {
        RestError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation",
            "effective_date must be YYYY-MM-DD",
        )
    })?;
    let record = state
        .store
        .change_sign_in_id(
            principal.user_id,
            target,
            SignInIdChange {
                login,
                effective_date,
                reason_code: body.reason_code,
                note: body.note.filter(|note| !note.trim().is_empty()),
            },
        )
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(record))
}

pub(crate) async fn sign_in_id_history(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Path(id): Path<uuid::Uuid>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage(&principal, Feature::UserManage)?;
    let target = UserId::from_uuid(id);
    state
        .store
        .get_user(target, &account_scope(&principal))
        .await
        .map_err(RestError::from_store)?;
    let items = state
        .store
        .sign_in_id_history(target)
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(serde_json::json!({ "items": items })))
}
