use crate::audit::record_auth_audit;
use crate::context::load::UserAuthContext;
use crate::cookies::token_pair_response;
use crate::error::RestError;
use crate::state::AuthRestState;
use crate::token::issue::issue_token_pair;
use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use console_kernel_core::BranchId;
use console_kernel_core::OrgId;
use console_kernel_core::UserId;
use console_platform_authz::Role;
use serde::Deserialize;
use std::str::FromStr;
use time::OffsetDateTime;
use uuid::Uuid;

/// POST /api/v1/dev-auth/session request body.
#[cfg(feature = "dev-auth")]
#[derive(Debug, Deserialize)]
pub(crate) struct DevAuthSessionRequest {
    pub(crate) org_id: Uuid,
    /// Canonical role code, e.g. `ADMIN` / `MECHANIC`.
    pub(crate) role: String,
    #[serde(default)]
    pub(crate) branch_ids: Vec<Uuid>,
    /// UI-gating hint only (exactly like the ordinary session's `feature_grants`
    /// claim) — backend authorization always re-resolves custom policy from the
    /// database per request and never trusts this claim.
    #[serde(default)]
    pub(crate) feature_grants: Vec<String>,
    #[serde(default)]
    pub(crate) display_name: Option<String>,
}

#[cfg(feature = "dev-auth")]
pub(crate) const DEV_AUTH_MAX_BRANCHES: usize = 32;
#[cfg(feature = "dev-auth")]
pub(crate) const DEV_AUTH_MAX_FEATURE_GRANTS: usize = 32;
#[cfg(feature = "dev-auth")]
pub(crate) const DEV_AUTH_MAX_FEATURE_GRANT_LEN: usize = 100;
#[cfg(feature = "dev-auth")]
pub(crate) const DEV_AUTH_MAX_DISPLAY_NAME_LEN: usize = 200;

/// Production-shaped display name for a dev-auth persona whose caller supplied
/// none. Keeps the identity chrome free of raw `dev:<ROLE>` debug labels — a
/// role-switch session reads as a real person, exactly like a production login
/// would. Dev-only (feature-gated) chrome.
#[cfg(feature = "dev-auth")]
pub(crate) fn dev_persona_display_name(role: &Role) -> &'static str {
    match role.as_str() {
        "SUPER_ADMIN" => "전성진",
        "EXECUTIVE" => "이대표",
        "MECHANIC" => "김정비",
        "RECEPTIONIST" => "박접수",
        _ => "개발 담당자",
    }
}

/// Mint a local role-switch session for any role/org/branch/feature-grant
/// combo. Unauthenticated by design (like `otp/redeem`/`signup`): it IS the
/// entry point, gated instead by not existing in a release build. Fails closed
/// on every input; never reachable unless the crate/binary was built with
/// `--features dev-auth`.
#[cfg(feature = "dev-auth")]
pub(crate) async fn dev_auth_session(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<DevAuthSessionRequest>,
) -> Result<Response, RestError> {
    let services = state.services()?;

    let org_id = OrgId::from_uuid(body.org_id);
    if org_id == OrgId::platform() {
        return Err(RestError::bad_request(
            "dev-auth cannot mint a platform-tier session",
        ));
    }
    let role =
        Role::from_str(&body.role).map_err(|_| RestError::bad_request("unknown role code"))?;
    if body.branch_ids.len() > DEV_AUTH_MAX_BRANCHES {
        return Err(RestError::bad_request("too many branch_ids"));
    }
    if body.feature_grants.len() > DEV_AUTH_MAX_FEATURE_GRANTS
        || body
            .feature_grants
            .iter()
            .any(|grant| grant.is_empty() || grant.len() > DEV_AUTH_MAX_FEATURE_GRANT_LEN)
    {
        return Err(RestError::bad_request("invalid feature_grants"));
    }
    let display_name = body
        .display_name
        .unwrap_or_else(|| dev_persona_display_name(&role).to_owned());
    let display_name = display_name.trim();
    if display_name.is_empty() || display_name.len() > DEV_AUTH_MAX_DISPLAY_NAME_LEN {
        return Err(RestError::bad_request(
            "display_name must be 1-200 characters",
        ));
    }

    let branch_ids: Vec<BranchId> = body
        .branch_ids
        .iter()
        .copied()
        .map(BranchId::from_uuid)
        .collect();
    let now = OffsetDateTime::now_utc();
    let principal = console_platform_provisioning::DevPrincipalProvisioner
        .upsert(
            &state.pool,
            console_platform_provisioning::DevPrincipalRequest {
                org_id,
                display_name: display_name.to_owned(),
                role: role.as_str().to_owned(),
                branch_ids: branch_ids.clone(),
            },
            now,
        )
        .await
        .map_err(RestError::from_provisioning)?;

    let user = UserAuthContext {
        user_id: UserId::from_uuid(principal.user_id),
        org_id,
        display_name: display_name.to_owned(),
        username: display_name.to_owned(),
        roles: vec![role.as_str().to_owned()],
        branches: branch_ids,
        group_roles: Vec::new(),
        feature_grants: body.feature_grants.clone(),
        // dev-auth builds the context without a DB read, so leave the safe 0
        // baseline. This is a dev-only build path and freshness is not consulted
        // by any decision in SLICE-2 anyway.
        authz_subject_version: 0,
        authz_policy_version: 0,
        session_generation: 0,
    };
    let tokens = issue_token_pair(&state.pool, services, &user).await?;

    // Loud by design: a dev-auth mint is a security-relevant event even in a
    // local/dev-only build, so it must never be silent.
    tracing::warn!(
        org_id = %body.org_id,
        role = role.as_str(),
        user_id = %principal.user_id,
        "dev-auth: minted a local role-switch session (dev-auth build only)"
    );
    record_auth_audit(
        &state.pool,
        org_id,
        *user.user_id.as_uuid(),
        "dev_auth.session.mint",
        serde_json::json!({
            "role": role.as_str(),
            "branch_ids": body.branch_ids,
        }),
    )
    .await?;

    Ok(token_pair_response(
        tokens,
        &headers,
        services.cookie_secure,
    ))
}

#[cfg(test)]
mod dev_auth_persona_tests {
    use super::dev_persona_display_name;
    use console_platform_authz::Role;
    use std::str::FromStr;

    #[test]
    fn dev_persona_name_is_a_real_person_never_a_dev_debug_label() {
        for code in [
            "SUPER_ADMIN",
            "ADMIN",
            "EXECUTIVE",
            "MECHANIC",
            "RECEPTIONIST",
            "MEMBER",
        ] {
            let role = Role::from_str(code).expect("known role code");
            let name = dev_persona_display_name(&role);
            assert!(
                !name.starts_with("dev:") && !name.is_empty(),
                "role {code} still renders a raw debug label: {name:?}"
            );
        }
        // The SUPER_ADMIN persona is the identity-chip reference (전성진 · 관리).
        assert_eq!(
            dev_persona_display_name(&Role::from_str("SUPER_ADMIN").unwrap()),
            "전성진"
        );
    }
}
