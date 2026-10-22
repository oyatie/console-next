// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
/// POST /api/platform/orgs — onboard a NEW tenant (the only place org rows are
/// created by the app), seed its first SUPER_ADMIN, and return a one-time OTP.
pub(crate) async fn create_org(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<PlatformPrincipal>,
    Json(body): Json<CreateOrgRequest>,
) -> Result<Response, PlatformError> {
    principal
        .authorize(PlatformFeature::TenantCreate)
        .map_err(|_| PlatformError::forbidden("platform principal cannot create tenants"))?;
    // An OTP-only platform session (no passkey enrolled yet) cannot create
    // tenants: the cold-start OTP alone must never be enough to mint orgs.
    // A platform token's org is always the platform sentinel (request-context
    // rejects `platform` claims for any other org).
    require_platform_passkey(
        &state,
        &principal,
        "enroll a passkey before creating tenants",
    )
    .await?;

    let onboarding = state
        .provisioner
        .onboard_tenant(
            &state.pool,
            Some(principal.user_id),
            &body.slug,
            &body.name,
            OffsetDateTime::now_utc(),
        )
        .await
        .map_err(PlatformError::from_provisioning)?;

    // Provision the standard governed-config object catalog (§4-26 SLO settings,
    // §19 console views) for the new tenant THROUGH the ontology engine (the
    // App-injected seeder), scoped to its freshly-created org so the registry
    // writes pass FORCE-RLS. The engine uses its own connection, so this runs
    // after the onboarding tx commits; a rare seeding failure surfaces as a 500
    // rather than silently leaving a tenant without its config catalog.
    // The seed's registry rows are `created_by` the actor, whose `(id, org_id)`
    // must reference a user IN the new org (FORCE-RLS + FK), so the actor is the
    // freshly-seeded tenant admin — never the platform principal (a sentinel-org
    // user that would fail the tenant-scoped FK).
    // not atomic with org creation (separate engine connection) — the
    // org row persists if this fails. Acceptable for a rare admin action; make the
    // seed tx-scoped only if half-provisioned tenants become an operational problem.
    if let Some(seeder) = &state.tenant_config_seeder {
        seeder(
            OrgId::from_uuid(onboarding.organization.id),
            UserId::from_uuid(onboarding.admin_user_id),
            OffsetDateTime::now_utc(),
        )
        .await
        .map_err(|err| {
            tracing::error!(error = %err, "seeding governed config object types for new tenant failed");
            PlatformError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "internal server error",
            )
        })?;
    }

    Ok((
        StatusCode::CREATED,
        Json(OnboardingResponse::from(onboarding)),
    )
        .into_response())
}

/// POST /api/platform/groups — create a group identity (not a tenant).
pub(crate) async fn create_group(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<PlatformPrincipal>,
    Json(body): Json<CreateGroupRequest>,
) -> Result<Response, PlatformError> {
    principal
        .authorize(PlatformFeature::GroupManage)
        .map_err(|_| PlatformError::forbidden("platform principal cannot create groups"))?;

    let group = state
        .provisioner
        .create_group(
            &state.pool,
            Some(principal.user_id),
            &body.slug,
            &body.name,
            OffsetDateTime::now_utc(),
        )
        .await
        .map_err(PlatformError::from_provisioning)?;

    Ok((StatusCode::CREATED, Json(GroupResponse::from(group))).into_response())
}
