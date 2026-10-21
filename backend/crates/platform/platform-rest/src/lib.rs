//! PLATFORM tier REST API â tenant onboarding and lifecycle.
//!
//! These routes live under `/api/platform/*` and are mounted behind the PLATFORM
//! extractor ([`console_platform_request_context::with_platform_context`]), NOT the
//! tenant org middleware. A TENANT token is rejected here (403) and a PLATFORM
//! token is rejected on the tenant `/api/v1/*` routes â the two tiers are strictly
//! separated, so a tenant admin can never reach a platform endpoint.
//!
//! They sit under the `/api` prefix so the ingress `/api`→backend rule reaches
//! them (the SPA owns the bare browser routes `/platform/*`); the `/api/platform`
//! namespace keeps the vendor data API collision-free with those client routes.
//!
//! Every write is cross-tenant and audited to the TARGET org (so the action
//! shows in both the platform and the tenant's audit trail).
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

mod company_domain;
mod dto;
mod error;
mod groups;
mod listing_authority;
mod orgs;
mod routes;
mod state_builders;
mod step_up;
mod tenant_delete;
mod view_as;

#[cfg(test)]
#[path = "../tests/fixtures/listings.rs"]
mod listings_tests;

pub use company_domain::TENANT_DOMAIN_REQUEST_PATH;
pub use state_builders::{OpsNotices, PlatformRestState};

pub use view_as::{
    PLATFORM_TENANT_CONTEXT_EXIT_PATH, PLATFORM_TENANT_CONTEXT_START_PATH,
    PLATFORM_VIEW_AS_EXIT_PATH, PLATFORM_VIEW_AS_START_PATH, TENANT_CONTEXT_TOKEN_TTL,
    VIEW_AS_READ_ONLY_CODE, VIEW_AS_TOKEN_TTL, with_view_as_read_only_gate,
};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, put};
use axum::{Extension, Json, Router};
use console_kernel_core::{OrgId, UserId};
use console_platform_authz::{PlatformFeature, PlatformPrincipal};
use serde::Deserialize;
use time::OffsetDateTime;
use uuid::Uuid;

use dto::{CreateGroupAccountResponse, GroupResponse, OnboardingResponse};
pub(crate) use error::PlatformError;
use groups::{
    assign_org_to_group, list_group_accounts, list_groups, remove_org_from_group, revoke_group_role,
};
use orgs::{list_orgs, ops_dashboard, reissue_org_admin_otp, update_org};
use step_up::{PlatformStepUpAssertion, require_platform_passkey, require_platform_step_up};
use tenant_delete::delete_org;

pub use routes::{
    PLATFORM_COMPANY_DOMAIN_PATH, PLATFORM_GROUP_ACCOUNT_ROLE_PATH_TEMPLATE,
    PLATFORM_GROUP_ACCOUNTS_PATH_TEMPLATE, PLATFORM_GROUP_ORG_PATH_TEMPLATE,
    PLATFORM_GROUP_PATH_TEMPLATE, PLATFORM_GROUPS_PATH, PLATFORM_OPS_PATH,
    PLATFORM_ORG_ADMIN_OTP_PATH_TEMPLATE, PLATFORM_ORG_PATH_TEMPLATE, PLATFORM_ORGS_PATH,
    PLATFORM_ROUTE_OPERATIONS, PLATFORM_ROUTE_PATHS, PlatformRouteOperation,
};

/// Injected port that provisions a NEW tenant's governed-config object catalog
/// (§4-26 SLO settings, §19 console views) THROUGH the ontology engine, scoped to
/// the new org. Modeled as a boxed async callback so the platform tier does NOT
/// depend on the ontology ADAPTER (the layer boundary forbids `platform → adapter`);
/// the App composition root (`console-app`) supplies the concrete engine-backed impl,
/// and the wiring test supplies its own. `None` skips seeding (e.g. tests that only
/// exercise onboarding shell behavior).
pub type TenantConfigSeeder = std::sync::Arc<
    dyn Fn(
            OrgId,
            UserId,
            OffsetDateTime,
        )
            -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>>
        + Send
        + Sync,
>;

/// Build the `/api/platform/*` router behind the PLATFORM extractor.
pub fn router(state: PlatformRestState) -> Router {
    let pool = state.pool.clone();
    let verifier = state.jwt_verifier.clone();
    let router = Router::new()
        .route(
            PLATFORM_COMPANY_DOMAIN_PATH,
            get(company_domain::availability),
        )
        .route(PLATFORM_ORGS_PATH, get(list_orgs).post(create_org))
        .route(
            PLATFORM_ORG_PATH_TEMPLATE,
            patch(update_org).delete(delete_org),
        )
        .route(
            PLATFORM_ORG_ADMIN_OTP_PATH_TEMPLATE,
            axum::routing::post(reissue_org_admin_otp),
        )
        .route(PLATFORM_GROUPS_PATH, get(list_groups).post(create_group))
        .route(PLATFORM_GROUP_PATH_TEMPLATE, patch(update_group))
        .route(
            PLATFORM_GROUP_ACCOUNTS_PATH_TEMPLATE,
            get(list_group_accounts).post(create_group_account),
        )
        .route(
            PLATFORM_GROUP_ACCOUNT_ROLE_PATH_TEMPLATE,
            axum::routing::delete(revoke_group_role),
        )
        .route(
            PLATFORM_GROUP_ORG_PATH_TEMPLATE,
            put(assign_org_to_group).delete(remove_org_from_group),
        )
        .route(PLATFORM_OPS_PATH, get(ops_dashboard));
    // View-as START + EXIT (read-only impersonation). Both are PLATFORM-tier
    // routes behind the platform extractor below; EXIT is platform-scoped so it
    // is reachable with the operator's platform token, never the view_as token.
    let tenant = console_platform_request_context::with_request_context(
        Router::new()
            .route(
                TENANT_DOMAIN_REQUEST_PATH,
                get(company_domain::own_request).post(company_domain::request_domain),
            )
            .with_state(state.clone()),
        verifier.clone(),
        pool.clone(),
    );
    let router = view_as::routes(router).with_state(state);
    // PLATFORM extractor: resolves the PlatformPrincipal and REJECTS any tenant
    // token. Deliberately NOT the tenant org middleware â the platform tier is
    // not tenant-scoped, and each handler arms the TARGET org per action.
    console_platform_request_context::with_platform_context(router, verifier, pool).merge(tenant)
}

// ---------------------------------------------------------------------------
// Request DTOs (kept beside their handlers: the request-body contract gate
// resolves a route's JSON body type in the router's own file)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct CreateOrgRequest {
    slug: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct CreateGroupRequest {
    slug: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct UpdateGroupRequest {
    #[serde(default)]
    slug: Option<String>,
    #[serde(default)]
    name: Option<String>,
    /// New group lifecycle status: ACTIVE | SUSPENDED | ARCHIVED.
    #[serde(default)]
    status: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CreateGroupAccountRequest {
    org_id: Uuid,
    display_name: String,
    #[serde(default)]
    phone: Option<String>,
    /// Tenant-local roles for the account's home org. Defaults to MEMBER so
    /// group authority remains explicit in group_role_grants.
    #[serde(default)]
    tenant_roles: Option<Vec<String>>,
    /// GROUP_ADMIN | GROUP_VIEWER | GROUP_FINANCE. Defaults to GROUP_ADMIN for
    /// the platform "add group account" workflow.
    #[serde(default)]
    group_role: Option<String>,
    /// The operator's fresh passkey assertion: the response carries the new
    /// account's one-time code, and `tenant_roles` may grant any tenant role.
    #[serde(default)]
    step_up: Option<PlatformStepUpAssertion>,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// POST /api/platform/orgs — onboard a NEW tenant (the only place org rows are
/// created by the app), seed its first SUPER_ADMIN, and return a one-time OTP.
async fn create_org(
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
async fn create_group(
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

/// PATCH /api/platform/groups/{id} — update group identity/status.
async fn update_group(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<PlatformPrincipal>,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateGroupRequest>,
) -> Result<Response, PlatformError> {
    principal
        .authorize(PlatformFeature::GroupManage)
        .map_err(|_| PlatformError::forbidden("platform principal cannot update groups"))?;

    let group = state
        .provisioner
        .update_group(
            &state.pool,
            Some(principal.user_id),
            id,
            body.slug.as_deref(),
            body.name.as_deref(),
            body.status.as_deref(),
            OffsetDateTime::now_utc(),
        )
        .await
        .map_err(PlatformError::from_provisioning)?;

    Ok(Json(GroupResponse::from(group)).into_response())
}

/// POST /api/platform/groups/{id}/accounts — create a tenant-anchored group account.
async fn create_group_account(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<PlatformPrincipal>,
    Path(id): Path<Uuid>,
    Json(body): Json<CreateGroupAccountRequest>,
) -> Result<Response, PlatformError> {
    principal
        .authorize(PlatformFeature::GroupManage)
        .map_err(|_| PlatformError::forbidden("platform principal cannot create group accounts"))?;
    require_platform_step_up(
        &state,
        &principal,
        body.step_up,
        console_platform_request_context::PASSKEY_REQUIRED_MESSAGE,
        "creating a group account requires a step-up assertion of your passkey",
    )
    .await?;

    let tenant_roles = body
        .tenant_roles
        .unwrap_or_else(|| vec!["MEMBER".to_owned()]);
    let group_role = body.group_role.unwrap_or_else(|| "GROUP_ADMIN".to_owned());
    let created = state
        .provisioner
        .create_group_account(
            &state.pool,
            Some(principal.user_id),
            id,
            body.org_id,
            &body.display_name,
            body.phone.as_deref(),
            &tenant_roles,
            &group_role,
            OffsetDateTime::now_utc(),
        )
        .await
        .map_err(PlatformError::from_provisioning)?;

    Ok((
        StatusCode::CREATED,
        Json(CreateGroupAccountResponse::from(created)),
    )
        .into_response())
}
