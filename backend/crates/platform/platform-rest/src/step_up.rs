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

/// Same enrollment/fresh assertion gate as other sensitive platform writes, with a BW-29 binding.
pub(crate) async fn require_bound_platform_step_up(
    state: &PlatformRestState,
    user: console_kernel_core::UserId,
    actor_org: OrgId,
    org: OrgId,
    id: Uuid,
    command: &console_platform_provisioning::OpsRecoveryCommand,
    envelope: Option<console_platform_auth::MobilePasskeyStepUpEnvelope>,
) -> Result<(sqlx::Transaction<'static, sqlx::Postgres>, Uuid), PlatformError> {
    require_bound_operator_step_up(
        state,
        user,
        actor_org,
        id,
        command
            .payload_hash(org, id)
            .map_err(PlatformError::from_provisioning)?,
        envelope,
    )
    .await
}

pub(crate) async fn require_bound_operator_step_up(
    state: &PlatformRestState,
    user: console_kernel_core::UserId,
    actor_org: OrgId,
    id: Uuid,
    payload_hash: String,
    envelope: Option<console_platform_auth::MobilePasskeyStepUpEnvelope>,
) -> Result<(sqlx::Transaction<'static, sqlx::Postgres>, Uuid), PlatformError> {
    if actor_org == OrgId::platform() {
        require_platform_passkey(
            state,
            &PlatformPrincipal::new(user),
            console_platform_request_context::PASSKEY_REQUIRED_MESSAGE,
        )
        .await?;
    } else if !console_platform_auth::user_has_passkey(&state.pool, actor_org, *user.as_uuid())
        .await
        .map_err(|_| {
            PlatformError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "internal server error",
            )
        })?
    {
        return Err(PlatformError::new(
            StatusCode::FORBIDDEN,
            "passkey_required",
            console_platform_request_context::PASSKEY_REQUIRED_MESSAGE,
        ));
    }
    let envelope = envelope.ok_or_else(|| {
        PlatformError::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "a recovery decision requires a fresh passkey assertion",
        )
    })?;
    let service = state.passkey_step_up.as_ref().ok_or_else(|| {
        PlatformError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "passkey step-up is not configured for the platform API",
        )
    })?;
    let expected = console_platform_auth::MobilePasskeyStepUpBinding {
        action_kind: console_platform_auth::MobileStepUpActionKind::OperatorRecovery,
        object_id: id,
        reason_key: "passkey_step_up_operator_recovery".into(),
        replay_attempt: None,
        payload_hash: Some(payload_hash),
    };
    let mut tx = state.pool.begin().await.map_err(|_| {
        PlatformError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal server error",
        )
    })?;
    let assertion = service
        .verify_and_record_step_up_in_tx(&mut tx, envelope, *user.as_uuid(), &expected)
        .await
        .map_err(|_| {
            PlatformError::new(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "passkey step-up failed",
            )
        })?;
    Ok((tx, assertion))
}
