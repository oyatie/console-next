use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use console_kernel_core::OrgId;
use console_platform_authz::{PlatformFeature, PlatformPrincipal};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::dto::{OrgResponse, PlatformOpsResponse, TenantHealthResponse};
use crate::step_up::{PlatformStepUpAssertion, require_platform_passkey, require_platform_step_up};
use crate::{PlatformError, PlatformRestState};

/// Body of `POST /api/platform/orgs/{id}/admin-otp`.
#[derive(Debug, Deserialize)]
pub(crate) struct AdminOtpReissueRequest {
    step_up: Option<PlatformStepUpAssertion>,
}

#[derive(Debug, Serialize)]
pub(crate) struct AdminOtpReissueResponse {
    admin_user_id: Uuid,
    admin_sign_in_id: Option<String>,
    /// The ONE-TIME replacement OTP. Returned exactly once, to be delivered
    /// out-of-band; never logged or stored in cleartext.
    otp: String,
    #[serde(with = "time::serde::rfc3339")]
    admin_otp_expires_at: OffsetDateTime,
}

/// POST /api/platform/orgs/{id}/admin-otp — reissue the one-time code of the
/// tenant's first SUPER_ADMIN while that admin has no passkey (a lost or
/// expired onboarding code). Same authority as onboarding; audited to the
/// target org; 409 once the admin has enrolled.
///
/// The operator must assert one of their passkeys in `step_up` (ceremony from
/// `passkey/login/start`), so a stolen platform token alone cannot mint a
/// tenant's first-admin code.
pub(crate) async fn reissue_org_admin_otp(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<PlatformPrincipal>,
    Path(id): Path<Uuid>,
    body: Option<Json<AdminOtpReissueRequest>>,
) -> Result<Response, PlatformError> {
    principal
        .authorize(PlatformFeature::TenantCreate)
        .map_err(|_| {
            PlatformError::forbidden("platform principal cannot reissue tenant admin codes")
        })?;
    require_platform_step_up(
        &state,
        &principal,
        body.and_then(|Json(body)| body.step_up),
        "enroll a passkey before reissuing tenant admin codes",
        "reissuing a tenant admin code requires a step-up assertion of your passkey",
    )
    .await?;
    let reissue = state
        .provisioner
        .reissue_tenant_admin_otp(
            &state.pool,
            Some(principal.user_id),
            id,
            OffsetDateTime::now_utc(),
        )
        .await
        .map_err(PlatformError::from_provisioning)?;
    Ok(Json(AdminOtpReissueResponse {
        admin_user_id: reissue.admin_user_id,
        admin_sign_in_id: reissue.admin_sign_in_id,
        otp: reissue.admin_otp.as_str().to_owned(),
        admin_otp_expires_at: reissue.admin_otp_expires_at,
    })
    .into_response())
}

/// GET /api/platform/orgs — list all tenants (cross-tenant, audited read).
pub(crate) async fn list_orgs(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<PlatformPrincipal>,
    Extension(claims): Extension<console_platform_auth::AccessClaims>,
) -> Result<Response, PlatformError> {
    let mut tx = crate::listing_authority::begin(
        &state,
        &principal,
        &claims,
        "tenants",
        "platform principal cannot list tenants",
    )
    .await?;

    let orgs = state
        .provisioner
        .list_tenants_in_tx(&mut tx, Some(principal.user_id), OffsetDateTime::now_utc())
        .await
        .map_err(PlatformError::from_provisioning)?;
    tx.commit()
        .await
        .map_err(crate::listing_authority::storage_error)?;

    // The console's `listPlatformOrgs` reads a bare array, so return the orgs
    // directly rather than wrapping them in an envelope.
    let items: Vec<OrgResponse> = orgs.into_iter().map(OrgResponse::from).collect();
    Ok(Json(items).into_response())
}

/// GET /api/platform/ops — cross-tenant ops health rollup (audited platform read).
///
/// Aggregates per-tenant health/usage numbers for EVERY tenant via the
/// SECURITY DEFINER `platform_org_health()` function â the only sanctioned
/// cross-tenant path. The read is audited (`platform.tenant.health`); a tenant
/// token is rejected with 403 by the platform extractor before this runs.
pub(crate) async fn ops_dashboard(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<PlatformPrincipal>,
    Extension(claims): Extension<console_platform_auth::AccessClaims>,
) -> Result<Response, PlatformError> {
    let mut tx = crate::listing_authority::begin(
        &state,
        &principal,
        &claims,
        "health",
        "platform principal cannot read tenant health",
    )
    .await?;

    let health = state
        .provisioner
        .list_tenant_health_in_tx(&mut tx, Some(principal.user_id), OffsetDateTime::now_utc())
        .await
        .map_err(PlatformError::from_provisioning)?;
    tx.commit()
        .await
        .map_err(crate::listing_authority::storage_error)?;

    let tenants = health.into_iter().map(TenantHealthResponse::from).collect();
    let notices = state.ops_notices.as_ref().map(|f| f()).unwrap_or_default();
    let registration_check_notices = state
        .registration_check_notices
        .as_ref()
        .map(|f| f())
        .unwrap_or_default();
    Ok(Json(PlatformOpsResponse {
        tenants,
        notices,
        registration_check_notices,
    })
    .into_response())
}

/// Body of `PATCH /api/platform/orgs/{id}`: any of the three; at least one.
#[derive(Debug, Deserialize)]
pub(crate) struct UpdateOrgRequest {
    /// New tenant status: ACTIVE | SUSPENDED | ARCHIVED.
    #[serde(default)]
    status: Option<String>,
    /// New display name (MR-21).
    #[serde(default)]
    name: Option<String>,
    /// New sign-in identifier (MR-21): `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`, unique.
    #[serde(default)]
    slug: Option<String>,
    #[serde(default)]
    step_up: Option<PlatformStepUpAssertion>,
}

/// PATCH /api/platform/orgs/{id} — rename a tenant (name, slug) and/or change
/// its status (suspend / reactivate / archive); each change audited. A rename
/// needs an enrolled operator passkey, as onboarding does (the slug is every
/// tenant user's sign-in identifier). The status is checked before the rename,
/// so a bad status never leaves a half-applied change. The platform sentinel is
/// never a target (404).
pub(crate) async fn update_org(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<PlatformPrincipal>,
    Path(id): Path<Uuid>,
    headers: axum::http::HeaderMap,
    Json(body): Json<UpdateOrgRequest>,
) -> Result<Response, PlatformError> {
    let key = headers
        .get(console_platform_db::idempotency::IDEMPOTENCY_KEY_HEADER)
        .map(|h| h.to_str().unwrap_or(""));
    if let Some(key) = key {
        console_platform_db::idempotency::validate_idempotency_key(Some(key))
            .map_err(PlatformError::validation)?;
        if body.status.is_some() {
            return Err(PlatformError::validation(
                "an idempotent domain change cannot include status",
            ));
        }
    }
    let renames = body.name.is_some() || body.slug.is_some();
    if !renames && body.status.is_none() {
        return Err(PlatformError::validation(
            "status, name or slug is required",
        ));
    }
    if let Some(status) = &body.status {
        principal
            .authorize(PlatformFeature::TenantSuspend)
            .map_err(|_| {
                PlatformError::forbidden("platform principal cannot change tenant status")
            })?;
        if !matches!(status.as_str(), "ACTIVE" | "SUSPENDED" | "ARCHIVED") {
            return Err(PlatformError::validation(format!(
                "invalid tenant status {status:?}"
            )));
        }
    }
    if id == *OrgId::platform().as_uuid() {
        return Err(PlatformError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "tenant not found",
        ));
    }
    let now = OffsetDateTime::now_utc();
    let mut org = None;
    if renames {
        principal
            .authorize(PlatformFeature::TenantCreate)
            .map_err(|_| PlatformError::forbidden("platform principal cannot rename tenants"))?;
        require_platform_passkey(
            &state,
            &principal,
            "enroll a passkey before renaming tenants",
        )
        .await?;
        if body.slug.is_some() {
            require_platform_step_up(
                &state,
                &principal,
                body.step_up,
                "enroll a passkey before renaming tenants",
                "assert a passkey before changing a company domain",
            )
            .await?;
        }
        org = Some(
            state
                .provisioner
                .rename_tenant_with_key(
                    &state.pool,
                    Some(principal.user_id),
                    id,
                    console_platform_provisioning::TenantRename {
                        slug: body.slug.as_deref(),
                        name: body.name.as_deref(),
                        idempotency_key: key,
                    },
                    now,
                )
                .await
                .map_err(PlatformError::from_provisioning)?,
        );
    }
    if let Some(status) = &body.status {
        org = Some(
            state
                .provisioner
                .set_tenant_status(&state.pool, Some(principal.user_id), id, status, now)
                .await
                .map_err(PlatformError::from_provisioning)?,
        );
    }
    let org = org.ok_or_else(|| PlatformError::validation("status, name or slug is required"))?;
    Ok(Json(OrgResponse::from(org)).into_response())
}
