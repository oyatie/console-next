use axum::http::StatusCode;
use console_kernel_core::OrgId;
use console_platform_auth::PasskeyAuthenticationCredential;
use console_platform_authz::PlatformPrincipal;
use serde::Deserialize;
use uuid::Uuid;

use crate::{PlatformError, PlatformRestState};

/// A fresh passkey assertion (same shape as `PasskeyStepUpAssertion`).
#[derive(Debug, Deserialize)]
pub(crate) struct PlatformStepUpAssertion {
    ceremony_id: Uuid,
    credential: PasskeyAuthenticationCredential,
}

/// Body of `PUT /api/platform/groups/{id}/organizations/{org_id}` and of a
/// FORCE `DELETE /api/platform/orgs/{id}?delete_data=true`.
#[derive(Debug, Deserialize)]
pub(crate) struct PlatformStepUpRequest {
    pub(crate) step_up: Option<PlatformStepUpAssertion>,
}

/// The 403 `passkey_required` gate for platform writes that mint sign-in
/// material: the cold-start OTP alone must never be enough.
pub(crate) async fn require_platform_passkey(
    state: &PlatformRestState,
    principal: &PlatformPrincipal,
    message: &'static str,
) -> Result<(), PlatformError> {
    let enrolled = console_platform_auth::user_has_passkey(
        &state.pool,
        OrgId::platform(),
        *principal.user_id.as_uuid(),
    )
    .await
    .map_err(|err| {
        tracing::error!(error = %err, "passkey enrollment check failed");
        PlatformError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal server error",
        )
    })?;
    if enrolled {
        Ok(())
    } else {
        Err(PlatformError::new(
            StatusCode::FORBIDDEN,
            "passkey_required",
            message,
        ))
    }
}

/// The gate for platform writes that hand out tenant authority or erase a
/// tenant: the operator holds a passkey (403 `passkey_required` otherwise) and
/// asserts it in this request (401 without or with a failing assertion), so a
/// stolen platform token alone is never enough.
pub(crate) async fn require_platform_step_up(
    state: &PlatformRestState,
    principal: &PlatformPrincipal,
    step_up: Option<PlatformStepUpAssertion>,
    enroll_message: &'static str,
    missing_message: &'static str,
) -> Result<(), PlatformError> {
    require_platform_passkey(state, principal, enroll_message).await?;
    let step_up = step_up.ok_or_else(|| {
        PlatformError::new(StatusCode::UNAUTHORIZED, "unauthorized", missing_message)
    })?;
    let verifier = state.passkey_step_up.as_ref().ok_or_else(|| {
        PlatformError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "passkey step-up is not configured for the platform API",
        )
    })?;
    verifier
        .verify_step_up_for_user(
            &state.pool,
            step_up.ceremony_id,
            step_up.credential,
            *principal.user_id.as_uuid(),
        )
        .await
        .map_err(|err| match err {
            console_platform_auth::AuthError::Sqlx(_) | console_platform_auth::AuthError::Db(_) => {
                tracing::error!(error = %err, "platform passkey step-up failed on the server");
                PlatformError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal",
                    "internal server error",
                )
            }
            _ => PlatformError::new(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "passkey step-up failed",
            ),
        })
}
