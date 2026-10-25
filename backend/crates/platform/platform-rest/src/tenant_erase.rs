// SPDX-License-Identifier: LicenseRef-Proprietary
//! Operator erasure commands share recovery's bound passkey verification.
use crate::{PlatformError, PlatformRestState};
use axum::{
    Extension, Json, Router,
    extract::{OriginalUri, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use console_kernel_core::OrgId;
use console_platform_auth::MobilePasskeyStepUpEnvelope;
use console_platform_authz::{PlatformFeature, PlatformPrincipal};
use console_platform_provisioning::{OpsRecoveryActor, TenantEraseCommand};
use serde::Deserialize;
use time::OffsetDateTime;
use uuid::Uuid;

pub(crate) fn routes(router: Router<PlatformRestState>) -> Router<PlatformRestState> {
    router
        .route(crate::PLATFORM_TENANT_ERASE_PATH, get(read).post(open))
        .route(crate::PLATFORM_TENANT_ERASE_APPROVE_PATH, post(decide))
        .route(crate::PLATFORM_TENANT_ERASE_CANCEL_PATH, post(decide))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenRequest {
    id: Uuid,
    step_up: Option<MobilePasskeyStepUpEnvelope>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DecisionRequest {
    step_up: Option<MobilePasskeyStepUpEnvelope>,
}
fn authority(p: &PlatformPrincipal) -> Result<(), PlatformError> {
    p.authorize(PlatformFeature::TenantRemove)
        .map_err(|_| PlatformError::forbidden("platform erasure authority required"))
}
async fn read(
    State(state): State<PlatformRestState>,
    Extension(p): Extension<PlatformPrincipal>,
    Path(org): Path<Uuid>,
) -> Result<Response, PlatformError> {
    authority(&p)?;
    let result = state
        .provisioner
        .read_tenant_erase(&state.pool, org, OffsetDateTime::now_utc())
        .await
        .map_err(PlatformError::from_provisioning)?;
    Ok(Json(result).into_response())
}
async fn open(
    State(state): State<PlatformRestState>,
    Extension(p): Extension<PlatformPrincipal>,
    Path(org): Path<Uuid>,
    Json(body): Json<OpenRequest>,
) -> Result<Response, PlatformError> {
    execute(
        &state,
        &p,
        org,
        body.id,
        TenantEraseCommand::Open,
        body.step_up,
    )
    .await
}
async fn decide(
    State(state): State<PlatformRestState>,
    Extension(p): Extension<PlatformPrincipal>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    OriginalUri(uri): OriginalUri,
    Json(body): Json<DecisionRequest>,
) -> Result<Response, PlatformError> {
    let command = if uri.path().ends_with("/approve") {
        TenantEraseCommand::Approve
    } else {
        TenantEraseCommand::Cancel
    };
    execute(&state, &p, org, id, command, body.step_up).await
}
async fn execute(
    state: &PlatformRestState,
    p: &PlatformPrincipal,
    org: Uuid,
    id: Uuid,
    command: TenantEraseCommand,
    envelope: Option<MobilePasskeyStepUpEnvelope>,
) -> Result<Response, PlatformError> {
    authority(p)?;
    let (mut tx, assertion) = crate::step_up::require_bound_operator_step_up(
        state,
        p.user_id,
        OrgId::platform(),
        id,
        command.payload_hash(org, id),
        envelope,
    )
    .await?;
    let result = state
        .provisioner
        .write_tenant_erase_in_tx(
            &mut tx,
            OpsRecoveryActor {
                user: p.user_id,
                org: OrgId::platform(),
                assertion,
            },
            org,
            id,
            command,
        )
        .await
        .map_err(PlatformError::from_provisioning)?;
    tx.commit().await.map_err(|_| {
        PlatformError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal server error",
        )
    })?;
    metrics::counter!("console_platform_tenant_erase_total", "action" => command.action())
        .increment(1);
    tracing::info!(action=command.action(),target_org=%org,request=%id,"tenant erasure command committed");
    Ok(Json(result).into_response())
}
