use crate::context::request::authenticated_user_context;
use crate::dto::passkey::MobilePasskeyStepUpStartRequest;
use crate::dto::passkey::MobilePasskeyStepUpStartResponse;
use crate::error::RestError;
use crate::rate_limit::passkey_error;
use crate::state::AuthRestState;
use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use console_platform_auth::PasskeyService;

/// Start an authenticated, action-bound mobile passkey step-up ceremony.
///
/// The ordinary login start route is pre-auth and intentionally usernameless; it
/// cannot bind a challenge to the approval/poll mutation a native app is about to
/// submit. This route verifies the bearer token first, stores the binding beside
/// the WebAuthn ceremony, and echoes the same binding back for generated clients.
pub(crate) async fn start_mobile_step_up(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<MobilePasskeyStepUpStartRequest>,
) -> Result<Json<MobilePasskeyStepUpStartResponse>, RestError> {
    let services = state.services()?;
    let (user_id, org_id) = authenticated_user_context(&state.pool, services, &headers).await?;
    body.binding
        .validate()
        .map_err(|err| RestError::validation(err.to_string()))?;
    let mut ceremony = services
        .passkeys
        .start_mobile_step_up(&state.pool, user_id, body.binding.clone())
        .await
        .map_err(|err| passkey_error(err, "passkey step-up failed"))?;
    // Name the caller's own keys, so a non-resident one confirms (decisions #33).
    PasskeyService::name_own_credentials(&state.pool, org_id, user_id, &mut ceremony)
        .await
        .map_err(|err| passkey_error(err, "passkey step-up failed"))?;

    Ok(Json(MobilePasskeyStepUpStartResponse {
        ceremony_id: ceremony.ceremony_id,
        challenge: serde_json::to_value(ceremony.challenge)
            .map_err(|err| RestError::internal(err.to_string()))?,
        expires_at: ceremony.expires_at,
        binding: body.binding,
    }))
}
