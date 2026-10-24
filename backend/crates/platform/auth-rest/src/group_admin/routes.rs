use crate::dto::group_admin::GroupAdminGroupsResponse;
use crate::dto::group_admin::GroupAdminTenantContextExitRequest;
use crate::dto::group_admin::GroupAdminTenantContextExitResponse;
use crate::dto::group_admin::GroupAdminTenantContextStartRequest;
use crate::dto::group_admin::GroupAdminTenantContextStartResponse;
use crate::error::RestError;
use crate::group_admin::actor::GROUP_ADMIN_TENANT_ACTING_ROLE;
use crate::group_admin::actor::authenticated_group_actor;
use crate::group_admin::store::load_group_admin_groups;
use crate::group_admin::store::record_group_tenant_context_audit;
use crate::group_admin::store::resolve_group_admin_target_org;
use crate::limits::GROUP_ADMIN_TENANT_CONTEXT_TTL;
use crate::state::AuthRestState;
use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use console_kernel_core::OrgId;
use console_platform_auth::AccessTokenInput;
use console_platform_db::read_subject_authz_freshness;
use time::OffsetDateTime;

/// GET /api/v1/group-admin/groups — list the ACTIVE groups/subsidiaries this
/// actor may manage. The JWT group_roles claim is NOT trusted here; the live
/// owner-only resolver is consulted on every call and only GROUP_ADMIN grants
/// qualify.
pub(crate) async fn list_group_admin_groups(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
) -> Result<Json<GroupAdminGroupsResponse>, RestError> {
    let services = state.services()?;
    let actor = authenticated_group_actor(&state.pool, services, &headers).await?;
    let groups = load_group_admin_groups(&state.pool, actor.id).await?;
    Ok(Json(GroupAdminGroupsResponse { groups }))
}

/// POST /api/v1/group-admin/tenant-context — mint a short-lived bounded tenant
/// token for one resolver-authorized subsidiary. This is the tenant-side analog
/// of the platform tenant-context endpoint, but it is strictly GROUP_ADMIN-only,
/// does not rely on the user's home tenant, and never mints an ordinary
/// SUPER_ADMIN session.
pub(crate) async fn start_group_admin_tenant_context(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<GroupAdminTenantContextStartRequest>,
) -> Result<Json<GroupAdminTenantContextStartResponse>, RestError> {
    let services = state.services()?;
    let actor = authenticated_group_actor(&state.pool, services, &headers).await?;
    let (group_id, target) =
        resolve_group_admin_target_org(&state.pool, actor.id, OrgId::from_uuid(body.org_id))
            .await?;

    // Source REAL subject freshness for the token's OWN (target subsidiary org,
    // actor) so a promoted Cedar guard — which re-reads exactly that (org, user)
    // at guard time — does not falsely deny this delegated token as stale/missing.
    // The read arms the target org's RLS GUC internally; the actor typically has
    // no `users` row in the subsidiary, so subject/session read as the absent 0
    // baseline while the subsidiary's `policy_version` is real.
    let freshness = read_subject_authz_freshness(&state.pool, target.org_id, actor.id)
        .await
        .map_err(|err| {
            tracing::error!(error = %err, "failed to read subject freshness for group-admin tenant-context");
            RestError::internal("internal server error")
        })?;

    let now = OffsetDateTime::now_utc();
    let expires_at = (now + GROUP_ADMIN_TENANT_CONTEXT_TTL).min(
        OffsetDateTime::from_unix_timestamp(actor.session.expires_at)
            .map_err(|_| RestError::unauthorized("invalid session expiry"))?,
    );
    let access_token = services
        .jwt_issuer
        .issue_group_admin_tenant_context_access_token(
            AccessTokenInput {
                subject: actor.id,
                org_id: target.org_id,
                roles: vec!["ADMIN".to_owned()],
                branches: Vec::new(),
                platform: false,
                support: None,
                read_only: false,
                display_name: None,
                feature_grants: Vec::new(),
                // Real subject freshness for (target subsidiary, actor): a promoted
                // Cedar guard re-reads the same (org, user), so a fresh token is not
                // falsely denied as stale/missing.
                authz_subject_version: freshness.subject_version,
                authz_policy_version: freshness.policy_version,
                session_generation: freshness.session_generation,
                issued_at: now,
            },
            group_id,
            actor.session,
            GROUP_ADMIN_TENANT_CONTEXT_TTL,
        )
        .map_err(|err| RestError::internal(err.to_string()))?;

    record_group_tenant_context_audit(
        &state.pool,
        actor.id,
        target.org_id,
        group_id,
        "group.tenant_context.start",
        now,
    )
    .await?;

    Ok(Json(GroupAdminTenantContextStartResponse {
        access_token,
        token_type: "Bearer",
        acting_org_id: *target.org_id.as_uuid(),
        acting_org_name: target.name,
        acting_role: GROUP_ADMIN_TENANT_ACTING_ROLE,
        expires_at,
    }))
}

/// POST /api/v1/group-admin/tenant-context/exit — audit the end of a group
/// admin's writable tenant context. The original group-admin session token must
/// be used; a missing/expired source session still lets the client exit locally,
/// but the audit endpoint fails closed.
pub(crate) async fn exit_group_admin_tenant_context(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<GroupAdminTenantContextExitRequest>,
) -> Result<Json<GroupAdminTenantContextExitResponse>, RestError> {
    let services = state.services()?;
    let actor = authenticated_group_actor(&state.pool, services, &headers).await?;
    let (group_id, target) =
        resolve_group_admin_target_org(&state.pool, actor.id, OrgId::from_uuid(body.org_id))
            .await?;

    record_group_tenant_context_audit(
        &state.pool,
        actor.id,
        target.org_id,
        group_id,
        "group.tenant_context.stop",
        OffsetDateTime::now_utc(),
    )
    .await?;

    Ok(Json(GroupAdminTenantContextExitResponse { ended: true }))
}

// ---------------------------------------------------------------------------
// dev-auth: local role-switch endpoint (feature-gated, NOT in default/release
// builds — see `console-gate-dev-auth-absence` and `Cargo.toml`'s `[features]`).
//
// # Why not `platform-rest`'s `support.rs`
//
// `support.rs` already mints real signed tokens through the same
// `console_platform_auth` issuance this endpoint uses, so its underlying primitive
// IS reused (see below) — but its HANDLER is the wrong shape for dev-auth, and
// deliberately not reused, for two independent reasons:
//
// 1. **Entry point vs. escalation.** `start_support` runs behind the PLATFORM
//    extractor: only an already-authenticated platform operator can reach it.
//    dev-auth must be the FIRST thing a developer calls with zero prior
//    session — an unauthenticated bootstrap like `otp/redeem`, not an
//    escalation of an existing one. Routing dev-auth through the platform
//    tier would mean either minting a fake platform token to satisfy that
//    extractor (defeats its entire "only platform tier can start" guarantee)
//    or weakening the extractor itself — both unacceptable.
// 2. **Read-only vs. read-write.** Every `support` token is permanently
//    mutation-blocked by `with_support_gate`, a BLANKET method gate
//    applied unconditionally to the tenant router (not itself feature-gated).
//    The role-switcher's whole point is exercising real CRUD as any role, so a
//    dev-auth session must carry `support = false`. Reusing `support`'s claim
//    shape would make every role-switch session permanently read-only.
//
// What IS reused: the one JWT issuance path every session-minting endpoint in
// this file already shares (`issue_token_pair` / `AccessTokenInput`, same
// signing keys, same `AccessClaims`) — no parallel signer, no new claim shape.
// The other reused piece is the `console-platform-provisioning` crate's user
// upsert pattern (`DevPrincipalProvisioner`, modeled on `apply_roster_tx`),
// because unlike `support` (which targets a REAL existing tenant role) a
// role-switch persona may not exist yet, and branch scope is re-resolved from
// a REAL `user_branches` row on every subsequent request.
// ---------------------------------------------------------------------------
