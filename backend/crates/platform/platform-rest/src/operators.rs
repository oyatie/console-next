// SPDX-License-Identifier: LicenseRef-Proprietary
//! Platform-tier second-operator listing, invitation, reissue, and revocation.

use crate::{PlatformError, PlatformRestState};
use axum::{
    Extension, Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use console_kernel_core::OrgId;
use console_platform_auth::{AccessClaims, MobilePasskeyStepUpEnvelope};
use console_platform_authz::{PlatformFeature, PlatformPrincipal};
use console_platform_provisioning::{
    InvitePlatformOperatorInput, PlatformOperatorStepUp, PlatformOperatorSummary,
};
use console_platform_request_context::{RequestContextError, validate_current_claims_in_tx};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

pub const PLATFORM_OPERATORS_PATH: &str = "/api/platform/operators";
pub const PLATFORM_OPERATOR_REISSUE_PATH: &str = "/api/platform/operators/{id}/reissue";
pub const PLATFORM_OPERATOR_REVOKE_PATH: &str = "/api/platform/operators/{id}/revoke";

pub(crate) fn routes(router: Router<PlatformRestState>) -> Router<PlatformRestState> {
    router
        .route(PLATFORM_OPERATORS_PATH, get(list).post(invite))
        .route(PLATFORM_OPERATOR_REISSUE_PATH, post(reissue))
        .route(PLATFORM_OPERATOR_REVOKE_PATH, post(revoke))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InvitePlatformOperatorRequest {
    id: Uuid,
    display_name: String,
    #[serde(default)]
    login: Option<String>,
    #[serde(default)]
    step_up: Option<MobilePasskeyStepUpEnvelope>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReissuePlatformOperatorInviteRequest {
    #[serde(default)]
    step_up: Option<MobilePasskeyStepUpEnvelope>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RevokePlatformOperatorRequest {
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    step_up: Option<MobilePasskeyStepUpEnvelope>,
}

#[derive(Serialize)]
struct PlatformOperatorInviteResponse {
    operator: PlatformOperatorSummary,
    invite_token: String,
    #[serde(with = "time::serde::rfc3339")]
    expires_at: OffsetDateTime,
}

fn authority(principal: &PlatformPrincipal) -> Result<(), PlatformError> {
    if principal.has_feature(PlatformFeature::OperatorManage) {
        Ok(())
    } else {
        Err(PlatformError::forbidden(
            "platform operator management authority required",
        ))
    }
}

fn map_claims_error(error: RequestContextError) -> PlatformError {
    match error {
        RequestContextError::InvalidToken | RequestContextError::InvalidClaim(_) => {
            PlatformError::new(StatusCode::UNAUTHORIZED, "unauthorized", error.to_string())
        }
        other => {
            tracing::error!(error = %other, "platform claims validation failed");
            PlatformError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "internal server error",
            )
        }
    }
}

fn internal_commit_error() -> PlatformError {
    PlatformError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal",
        "internal server error",
    )
}

async fn list(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<PlatformPrincipal>,
    Extension(claims): Extension<AccessClaims>,
) -> Result<Response, PlatformError> {
    authority(&principal)?;
    let mut tx = crate::listing_authority::begin(
        &state,
        &principal,
        &claims,
        "operators",
        "platform principal cannot list operators",
    )
    .await?;
    let operators = state
        .provisioner
        .list_platform_operators_in_tx(&mut tx, principal.user_id, OffsetDateTime::now_utc())
        .await
        .map_err(PlatformError::from_provisioning)?;
    tx.commit()
        .await
        .map_err(crate::listing_authority::storage_error)?;
    Ok(Json(operators).into_response())
}

async fn invite(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<PlatformPrincipal>,
    Extension(claims): Extension<AccessClaims>,
    Json(body): Json<InvitePlatformOperatorRequest>,
) -> Result<Response, PlatformError> {
    authority(&principal)?;
    let payload_hash = PlatformOperatorStepUp::invite_payload_hash(
        body.id,
        &body.display_name,
        body.login.as_deref(),
    )
    .map_err(PlatformError::from_provisioning)?;
    let (mut tx, assertion) = crate::step_up::require_bound_operator_step_up(
        &state,
        principal.user_id,
        OrgId::platform(),
        body.id,
        payload_hash,
        body.step_up,
    )
    .await?;
    let (user, org) = validate_current_claims_in_tx(&mut tx, &claims)
        .await
        .map_err(map_claims_error)?;
    if user != principal.user_id
        || org != OrgId::platform()
        || !claims.platform
        || claims.enrollment
    {
        return Err(PlatformError::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "invalid bearer token",
        ));
    }
    let outcome = state
        .provisioner
        .invite_platform_operator_in_tx(
            &mut tx,
            principal.user_id,
            assertion,
            InvitePlatformOperatorInput {
                id: body.id,
                display_name: body.display_name,
                login: body.login,
            },
            OffsetDateTime::now_utc(),
        )
        .await
        .map_err(PlatformError::from_provisioning)?;
    tx.commit().await.map_err(|_| internal_commit_error())?;
    tracing::info!(
        actor = %principal.user_id,
        target_user = %outcome.operator.user_id,
        "platform operator invited"
    );
    Ok((
        StatusCode::CREATED,
        Json(PlatformOperatorInviteResponse {
            operator: outcome.operator,
            invite_token: outcome.invite_token.as_str().to_owned(),
            expires_at: outcome.expires_at,
        }),
    )
        .into_response())
}

async fn reissue(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<PlatformPrincipal>,
    Extension(claims): Extension<AccessClaims>,
    Path(id): Path<Uuid>,
    Json(body): Json<ReissuePlatformOperatorInviteRequest>,
) -> Result<Response, PlatformError> {
    authority(&principal)?;
    let payload_hash = PlatformOperatorStepUp::reissue_payload_hash(id)
        .map_err(PlatformError::from_provisioning)?;
    let (mut tx, assertion) = crate::step_up::require_bound_operator_step_up(
        &state,
        principal.user_id,
        OrgId::platform(),
        id,
        payload_hash,
        body.step_up,
    )
    .await?;
    let (user, org) = validate_current_claims_in_tx(&mut tx, &claims)
        .await
        .map_err(map_claims_error)?;
    if user != principal.user_id
        || org != OrgId::platform()
        || !claims.platform
        || claims.enrollment
    {
        return Err(PlatformError::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "invalid bearer token",
        ));
    }
    let outcome = state
        .provisioner
        .reissue_platform_operator_invite_in_tx(
            &mut tx,
            principal.user_id,
            assertion,
            id,
            OffsetDateTime::now_utc(),
        )
        .await
        .map_err(PlatformError::from_provisioning)?;
    tx.commit().await.map_err(|_| internal_commit_error())?;
    tracing::info!(
        actor = %principal.user_id,
        target_user = %outcome.operator.user_id,
        "platform operator invite reissued"
    );
    Ok(Json(PlatformOperatorInviteResponse {
        operator: outcome.operator,
        invite_token: outcome.invite_token.as_str().to_owned(),
        expires_at: outcome.expires_at,
    })
    .into_response())
}

async fn revoke(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<PlatformPrincipal>,
    Extension(claims): Extension<AccessClaims>,
    Path(id): Path<Uuid>,
    Json(body): Json<RevokePlatformOperatorRequest>,
) -> Result<Response, PlatformError> {
    authority(&principal)?;
    let payload_hash = PlatformOperatorStepUp::revoke_payload_hash(id, body.reason.as_deref())
        .map_err(PlatformError::from_provisioning)?;
    let (mut tx, assertion) = crate::step_up::require_bound_operator_step_up(
        &state,
        principal.user_id,
        OrgId::platform(),
        id,
        payload_hash,
        body.step_up,
    )
    .await?;
    let (user, org) = validate_current_claims_in_tx(&mut tx, &claims)
        .await
        .map_err(map_claims_error)?;
    if user != principal.user_id
        || org != OrgId::platform()
        || !claims.platform
        || claims.enrollment
    {
        return Err(PlatformError::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "invalid bearer token",
        ));
    }
    let summary = state
        .provisioner
        .revoke_platform_operator_in_tx(
            &mut tx,
            principal.user_id,
            assertion,
            id,
            body.reason.as_deref(),
            OffsetDateTime::now_utc(),
        )
        .await
        .map_err(PlatformError::from_provisioning)?;
    tx.commit().await.map_err(|_| internal_commit_error())?;
    tracing::info!(
        actor = %principal.user_id,
        target_user = %summary.user_id,
        "platform operator revoked"
    );
    Ok(Json(summary).into_response())
}
