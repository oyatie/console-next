// SPDX-License-Identifier: LicenseRef-Proprietary
//! Vendor and tenant faces of the governed, same-holder recovery use case.
use crate::step_up::require_bound_platform_step_up as require_platform_step_up;
use crate::{PlatformError, PlatformRestState};
use axum::{
    Extension, Json,
    extract::{OriginalUri, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::MobilePasskeyStepUpEnvelope;
use console_platform_authz::{PlatformFeature, PlatformPrincipal, Principal};
use console_platform_provisioning::{OpsRecoveryActor, OpsRecoveryCommand};
use serde::Deserialize;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum AuthoriserRole {
    Representative,
    SecurityContact,
}
impl AuthoriserRole {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Representative => "REPRESENTATIVE",
            Self::SecurityContact => "SECURITY_CONTACT",
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OpenRequest {
    id: Uuid,
    authoriser_role: AuthoriserRole,
    authoriser_name: String,
    proofing_method: String,
    evidence_ref: String,
    step_up: Option<MobilePasskeyStepUpEnvelope>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DecisionRequest {
    step_up: Option<MobilePasskeyStepUpEnvelope>,
    reason: Option<String>,
}

fn authority(p: &PlatformPrincipal) -> Result<(), PlatformError> {
    p.authorize(PlatformFeature::TenantCreate)
        .map_err(|_| PlatformError::forbidden("platform recovery authority required"))
}
fn key(headers: &HeaderMap) -> Result<String, PlatformError> {
    console_platform_db::idempotency::validate_idempotency_key(
        headers
            .get(console_platform_db::idempotency::IDEMPOTENCY_KEY_HEADER)
            .and_then(|h| h.to_str().ok()),
    )
    .map_err(PlatformError::validation)
}
pub(crate) async fn vendor_read(
    State(state): State<PlatformRestState>,
    Extension(p): Extension<PlatformPrincipal>,
    Path(id): Path<Uuid>,
) -> Result<Response, PlatformError> {
    authority(&p)?;
    let result = state
        .provisioner
        .read_ops_recovery(
            &state.pool,
            OrgId::from_uuid(id),
            true,
            OffsetDateTime::now_utc(),
        )
        .await
        .map_err(PlatformError::from_provisioning)?;
    Ok(Json(result).into_response())
}
pub(crate) async fn tenant_read(
    State(state): State<PlatformRestState>,
    Extension(p): Extension<Principal>,
) -> Result<Response, PlatformError> {
    let result = state
        .provisioner
        .read_ops_recovery(&state.pool, p.org_id, false, OffsetDateTime::now_utc())
        .await
        .map_err(PlatformError::from_provisioning)?;
    Ok(Json(result).into_response())
}
pub(crate) async fn open(
    State(state): State<PlatformRestState>,
    Extension(p): Extension<PlatformPrincipal>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<OpenRequest>,
) -> Result<Response, PlatformError> {
    authority(&p)?;
    execute(
        &state,
        p.user_id,
        OrgId::platform(),
        OrgId::from_uuid(id),
        body.id,
        OpsRecoveryCommand::Open {
            authoriser_role: body.authoriser_role.as_str().into(),
            authoriser_name: body.authoriser_name,
            proofing_method: body.proofing_method,
            evidence_ref: body.evidence_ref,
        },
        body.step_up,
        &key(&headers)?,
    )
    .await
}
pub(crate) async fn decide(
    State(state): State<PlatformRestState>,
    Extension(p): Extension<PlatformPrincipal>,
    Path((id, rid)): Path<(Uuid, Uuid)>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    Json(body): Json<DecisionRequest>,
) -> Result<Response, PlatformError> {
    authority(&p)?;
    let command = match uri.path().rsplit('/').next() {
        Some("approve") => OpsRecoveryCommand::Approve,
        Some("issue") => OpsRecoveryCommand::Issue,
        Some("cancel") => OpsRecoveryCommand::Cancel {
            reason: body
                .reason
                .ok_or_else(|| PlatformError::validation("cancel reason is required"))?,
        },
        _ => return Err(PlatformError::validation("unknown recovery action")),
    };
    execute(
        &state,
        p.user_id,
        OrgId::platform(),
        OrgId::from_uuid(id),
        rid,
        command,
        body.step_up,
        &key(&headers)?,
    )
    .await
}
pub(crate) async fn tenant_cancel(
    State(state): State<PlatformRestState>,
    Extension(p): Extension<Principal>,
    Path(rid): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<DecisionRequest>,
) -> Result<Response, PlatformError> {
    // Resolve the tenant-scoped request before assertion verification: foreign ids remain 404.
    let read = state
        .provisioner
        .read_ops_recovery(&state.pool, p.org_id, false, OffsetDateTime::now_utc())
        .await
        .map_err(PlatformError::from_provisioning)?;
    if read.request.as_ref().map(|r| r.id) != Some(rid) {
        return Err(PlatformError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "recovery request not found",
        ));
    }
    execute(
        &state,
        p.user_id,
        p.org_id,
        p.org_id,
        rid,
        OpsRecoveryCommand::Cancel {
            reason: body
                .reason
                .ok_or_else(|| PlatformError::validation("cancel reason is required"))?,
        },
        body.step_up,
        &key(&headers)?,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn execute(
    state: &PlatformRestState,
    user: UserId,
    actor_org: OrgId,
    org: OrgId,
    id: Uuid,
    command: OpsRecoveryCommand,
    envelope: Option<MobilePasskeyStepUpEnvelope>,
    key: &str,
) -> Result<Response, PlatformError> {
    let (mut tx, assertion) =
        require_platform_step_up(state, user, actor_org, org, id, &command, envelope).await?;
    let result = state
        .provisioner
        .write_ops_recovery_in_tx(
            &mut tx,
            OpsRecoveryActor {
                user,
                org: actor_org,
                assertion,
            },
            org,
            id,
            command,
            key,
            OffsetDateTime::now_utc(),
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
    Ok(Json(result).into_response())
}
