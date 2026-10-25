use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use console_platform_authz::{PlatformFeature, PlatformPrincipal};
use console_platform_provisioning::TenantRemovalOutcome;
use serde::Deserialize;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::step_up::{PlatformStepUpRequest, require_platform_step_up};
use crate::{PlatformError, PlatformRestState};

/// Legacy force callers retain the query shape but must create a governed request.
#[derive(Debug, Deserialize)]
pub(crate) struct DeleteOrgQuery {
    #[serde(default)]
    delete_data: bool,
}

/// Guarded empty-shell removal; data erasure uses the two-operator request API.
pub(crate) async fn delete_org(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<PlatformPrincipal>,
    Path(id): Path<Uuid>,
    Query(query): Query<DeleteOrgQuery>,
    body: Option<Json<PlatformStepUpRequest>>,
) -> Result<Response, PlatformError> {
    // Same authz gate for BOTH paths: platform super-admin only. A tenant token is
    // already rejected (403) by the platform extractor before this handler runs.
    principal
        .authorize(PlatformFeature::TenantRemove)
        .map_err(|_| PlatformError::forbidden("platform principal cannot remove tenants"))?;
    // Erasing a tenant's data cannot be undone: a fresh passkey assertion.
    if query.delete_data {
        require_platform_step_up(
            &state,
            &principal,
            body.and_then(|Json(body)| body.step_up),
            console_platform_request_context::PASSKEY_REQUIRED_MESSAGE,
            "force-removing a tenant requires a step-up assertion of your passkey",
        )
        .await?;
    }

    let actor = Some(principal.user_id);
    let now = OffsetDateTime::now_utc();
    let outcome = if query.delete_data {
        state.force_remove_command_pool.as_ref().ok_or_else(|| {
            PlatformError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "platform_force_command_unavailable",
                "platform force-remove command capability is unavailable",
            )
        })?;
        let facts = state
            .provisioner
            .read_tenant_erase(&state.pool, id, now)
            .await
            .map_err(PlatformError::from_provisioning)?;
        if facts.legal_hold {
            return Err(PlatformError::new(
                StatusCode::CONFLICT,
                "blocked_legal_hold",
                "tenant is under legal hold",
            ));
        }
        if !facts.archived {
            return Err(PlatformError::new(
                StatusCode::CONFLICT,
                "tenant_active",
                "archive the tenant before requesting erasure",
            ));
        }
        return Err(PlatformError::new(
            StatusCode::CONFLICT,
            "erase_requires_second_operator",
            "create a governed tenant erasure request",
        ));
    } else {
        state
            .provisioner
            .remove_tenant(&state.pool, actor, id, now)
            .await
    }
    .map_err(PlatformError::from_provisioning)?;

    match outcome {
        TenantRemovalOutcome::Removed => Ok(StatusCode::NO_CONTENT.into_response()),
        TenantRemovalOutcome::BlockedHasData => Err(PlatformError::new(
            StatusCode::CONFLICT,
            "tenant_has_data",
            "tenant has operational data and cannot be removed; archive it instead",
        )),
        TenantRemovalOutcome::BlockedLegalHold => Err(PlatformError::new(
            StatusCode::CONFLICT,
            "blocked_legal_hold",
            "법적 보존 조치가 적용되어 삭제하지 않았습니다. 보존 담당자에게 사건 상태를 확인하십시오.",
        )),
        TenantRemovalOutcome::BlockedActive => Err(PlatformError::new(
            StatusCode::CONFLICT,
            "tenant_active",
            "archive the tenant before force-removing",
        )),
        TenantRemovalOutcome::NotFound => Err(PlatformError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "no such tenant",
        )),
    }
}
