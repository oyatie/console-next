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

/// Query params for `DELETE /api/platform/orgs/{id}`.
#[derive(Debug, Deserialize)]
pub(crate) struct DeleteOrgQuery {
    /// Opt-in FORCE removal: when true, take the DESTRUCTIVE path that erases the
    /// tenant AND all of its data (requires the tenant to be ARCHIVED first).
    /// Defaults to false — the GUARDED path that removes only an empty shell.
    #[serde(default)]
    delete_data: bool,
}

/// DELETE /api/platform/orgs/{id}[?delete_data=true] — remove a tenant.
///
/// Platform-super-admin (vendor tier) ONLY â identical gate to `update_org`; a
/// tenant's own admin can never reach this (the platform extractor rejects a
/// tenant token with 403 before this runs).
///
/// Two paths, selected by the opt-in `delete_data` query param (default false):
///   * `delete_data=false` (default) â GUARDED removal (`platform.tenant.remove`).
///     Removes only an empty/test tenant's onboarding shell; REFUSES with 409
///     (code `tenant_has_data`) when the tenant owns real operational data,
///     telling the operator to archive instead. Unchanged behaviour.
///   * `delete_data=true` â FORCE removal (`platform.tenant.force_remove`). The
///     DESTRUCTIVE path: erases the org AND all of its data. Fail-closed by a
///     status rail â REFUSES with 409 (code `tenant_active`) unless the tenant is
///     ARCHIVED, telling the operator to archive (reversible) before force-
///     removing. Erasing real data is the whole point, so there is no has_data
///     guard on this path.
///
/// Both paths delete in ONE transaction and preserve the tenant's immutable audit
/// trail (re-homed to the platform sentinel). A missing tenant is 404.
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
        let force_pool = state.force_remove_command_pool.as_ref().ok_or_else(|| {
            PlatformError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "platform_force_command_unavailable",
                "platform force-remove command capability is unavailable",
            )
        })?;
        state
            .provisioner
            .force_remove_tenant(force_pool, actor, id, now)
            .await
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
