// SPDX-License-Identifier: LicenseRef-Proprietary
//! Platform and tenant REST handlers for 7-day group join invitations (BG-12a).
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use console_platform_authz::{PlatformFeature, PlatformPrincipal, Principal};
use serde::Deserialize;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::dto::OrgResponse;
use crate::step_up::{PlatformStepUpAssertion, require_platform_step_up};
use crate::{PlatformError, PlatformRestState};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CreateGroupInvitationRequest {
    pub(crate) org_id: Uuid,
    #[serde(default)]
    pub(crate) step_up: Option<PlatformStepUpAssertion>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AcceptTenantGroupInvitationRequest {
    #[serde(default)]
    pub(crate) step_up: Option<PlatformStepUpAssertion>,
}

async fn verify_tenant_step_up(
    state: &PlatformRestState,
    principal: &Principal,
    step_up: Option<PlatformStepUpAssertion>,
) -> Result<(), PlatformError> {
    if !console_platform_auth::user_has_passkey(
        &state.pool,
        principal.org_id,
        *principal.user_id.as_uuid(),
    )
    .await
    .map_err(|_| {
        PlatformError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal server error",
        )
    })? {
        return Err(PlatformError::new(
            StatusCode::FORBIDDEN,
            "passkey_required",
            console_platform_request_context::PASSKEY_REQUIRED_MESSAGE,
        ));
    }
    let step_up = step_up.ok_or_else(|| {
        PlatformError::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "accepting a group join invitation requires a fresh passkey assertion",
        )
    })?;
    let verifier = state.passkey_step_up.as_ref().ok_or_else(|| {
        PlatformError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "passkey step-up is not configured",
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
        .map_err(|_| {
            PlatformError::new(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "passkey step-up failed",
            )
        })
}

pub(crate) async fn create_invitation(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<PlatformPrincipal>,
    Path(id): Path<Uuid>,
    Json(body): Json<CreateGroupInvitationRequest>,
) -> Result<Response, PlatformError> {
    principal
        .authorize(PlatformFeature::GroupManage)
        .map_err(|_| PlatformError::forbidden("platform principal cannot invite group members"))?;
    require_platform_step_up(
        &state,
        &principal,
        body.step_up,
        console_platform_request_context::PASSKEY_REQUIRED_MESSAGE,
        "inviting an organization into a group requires a step-up assertion of your passkey",
    )
    .await?;

    let created = state
        .provisioner
        .create_group_join_invitation(
            &state.pool,
            principal.user_id,
            id,
            body.org_id,
            OffsetDateTime::now_utc(),
        )
        .await
        .map_err(PlatformError::from_provisioning)?;

    Ok((StatusCode::CREATED, Json(created)).into_response())
}

pub(crate) async fn cancel_invitation(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<PlatformPrincipal>,
    Path((id, invitation_id)): Path<(Uuid, Uuid)>,
) -> Result<Response, PlatformError> {
    principal
        .authorize(PlatformFeature::GroupManage)
        .map_err(|_| {
            PlatformError::forbidden("platform principal cannot cancel group invitations")
        })?;

    state
        .provisioner
        .cancel_group_join_invitation(
            &state.pool,
            principal.user_id,
            id,
            invitation_id,
            OffsetDateTime::now_utc(),
        )
        .await
        .map_err(PlatformError::from_provisioning)?;

    Ok(StatusCode::NO_CONTENT.into_response())
}

pub(crate) async fn list_tenant_invitations(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<Principal>,
) -> Result<Response, PlatformError> {
    let items = state
        .provisioner
        .list_tenant_group_invitations(&state.pool, principal.user_id, principal.org_id)
        .await
        .map_err(PlatformError::from_provisioning)?;
    Ok(Json(serde_json::json!({ "items": items })).into_response())
}

pub(crate) async fn accept_tenant_invitation(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<Principal>,
    Path(invitation_id): Path<Uuid>,
    Json(body): Json<AcceptTenantGroupInvitationRequest>,
) -> Result<Response, PlatformError> {
    verify_tenant_step_up(&state, &principal, body.step_up).await?;
    let org = state
        .provisioner
        .accept_tenant_group_invitation(
            &state.pool,
            principal.user_id,
            principal.org_id,
            invitation_id,
            OffsetDateTime::now_utc(),
        )
        .await
        .map_err(PlatformError::from_provisioning)?;
    Ok(Json(OrgResponse::from(org)).into_response())
}

pub(crate) async fn decline_tenant_invitation(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<Principal>,
    Path(invitation_id): Path<Uuid>,
) -> Result<Response, PlatformError> {
    state
        .provisioner
        .decline_tenant_group_invitation(
            &state.pool,
            principal.user_id,
            principal.org_id,
            invitation_id,
            OffsetDateTime::now_utc(),
        )
        .await
        .map_err(PlatformError::from_provisioning)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
