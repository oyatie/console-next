use crate::error::RestError;
use crate::policy::dto::PolicyStepUpAssertionRequest;
use crate::state::IdentityRestState;
use axum::http::StatusCode;
use console_platform_authz::Principal;

pub(crate) async fn verify_policy_step_up(
    state: &IdentityRestState,
    principal: &Principal,
    step_up: Option<PolicyStepUpAssertionRequest>,
) -> Result<(), RestError> {
    verify_step_up(
        state,
        principal,
        step_up,
        "policy changes require a fresh passkey step-up",
    )
    .await
}

/// 428 `passkey_step_up_required` without an assertion, 401 when it does not
/// verify against one of the caller's own passkeys.
pub(crate) async fn verify_step_up(
    state: &IdentityRestState,
    principal: &Principal,
    step_up: Option<PolicyStepUpAssertionRequest>,
    missing_message: &'static str,
) -> Result<(), RestError> {
    let step_up = step_up.ok_or_else(|| {
        RestError::new(
            StatusCode::PRECONDITION_REQUIRED,
            "passkey_step_up_required",
            missing_message,
        )
    })?;
    let verifier = state.passkey_step_up.as_ref().ok_or_else(|| {
        RestError::unavailable("passkey step-up is not configured for identity API")
    })?;
    verifier
        .verify_step_up_for_user(
            state.pool(),
            step_up.ceremony_id,
            step_up.credential,
            *principal.user_id.as_uuid(),
        )
        .await
        .map_err(|_| RestError::unauthorized("passkey step-up failed"))?;
    Ok(())
}
