use crate::context::load::load_user_auth_context_in_org;
use crate::context::request::principal_from_headers;
use crate::context::request::resolve_otp_ttl;
use crate::dto::admin::AdminCredentialResetRequest;
use crate::dto::admin::AdminCredentialResetResponse;
use crate::dto::admin::AdminIssueOtpRequest;
use crate::dto::admin::AdminIssueOtpResponse;
use crate::error::RestError;
use crate::limits::DEFAULT_OTP_TTL;
use crate::otp::authorizable_target_branches;
use crate::rate_limit::RateLimitEndpoint;
use crate::rate_limit::passkey_error;
use crate::rate_limit::rate_limit_caller;
use crate::state::AuthRestState;
use crate::util::forbidden_if_unauthorized;
use crate::util::parse_roles;
use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use console_kernel_core::BranchId;
use console_platform_authz::Action;
use console_platform_authz::Feature;
use console_platform_authz::Role;
use console_platform_authz::authorize;
use console_platform_authz::authorize_capability;
use console_platform_authz::resolve_branch_scope_in_org;
use time::OffsetDateTime;

/// IDOR hardening: authorization is bound to the TARGET user's real branch/role
/// resolved from the database, NOT to the client-supplied `body.branch_id`. The
/// caller must be authorized for `SubordinateUserCreate` against EVERY branch the
/// target belongs to, and a non-SUPER_ADMIN caller can never mint a code for an
/// EXECUTIVE or SUPER_ADMIN target. This stops a branch-A admin from minting a
/// sign-in OTP for a privileged user or for a user who lives in branch B. An
/// org-wide (privileged) target is issuable only by a SUPER_ADMIN — see
/// [`authorizable_target_branches`].
pub(crate) async fn issue_admin_otp(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<AdminIssueOtpRequest>,
) -> Result<Json<AdminIssueOtpResponse>, RestError> {
    let services = state.services()?;
    let principal = principal_from_headers(&state.pool, services, &headers).await?;
    // An OTP-only session (no passkey enrolled yet) must not mint sign-in codes
    // for others: a leaked OTP would otherwise chain into more accounts.
    if !console_platform_auth::user_has_passkey(
        &state.pool,
        principal.org_id,
        *principal.user_id.as_uuid(),
    )
    .await
    .map_err(|err| RestError::internal(err.to_string()))?
    {
        return Err(RestError::passkey_required());
    }
    rate_limit_caller(
        &state.pool,
        *principal.user_id.as_uuid(),
        RateLimitEndpoint::AdminOtpIssue,
        OffsetDateTime::now_utc(),
    )
    .await?;

    // Resolve the TARGET's real roles. A missing or inactive target is a 403 here
    // (the caller is authenticated; it is the requested target that is invalid),
    // not the 401 the sign-in paths use. The target lives in the caller's tenant
    // (an admin can only manage users in its own org), so arm the GUC with the
    // caller's verified org for this RLS-gated read.
    let target = load_user_auth_context_in_org(&state.pool, principal.org_id, body.user_id)
        .await
        .map_err(forbidden_if_unauthorized)?;
    let target_roles = parse_roles(&target.roles)?;

    let caller_is_super_admin = principal.roles.contains(&Role::SuperAdmin);

    // A non-SUPER_ADMIN caller may never issue a code for a privileged target.
    let target_is_privileged = target_roles
        .iter()
        .any(|role| matches!(role, Role::Executive | Role::SuperAdmin));
    if target_is_privileged && !caller_is_super_admin {
        return Err(RestError::forbidden(
            "not allowed to issue sign-in codes for a privileged user",
        ));
    }

    // Resolve the target's REAL branch scope and require the caller to be
    // authorized against every one of the target's branches. A target with All
    // scope (SUPER_ADMIN/EXECUTIVE) or no branches cannot be issued for here.
    let target_scope =
        resolve_branch_scope_in_org(&state.pool, principal.org_id, target.user_id, &target_roles)
            .await
            .map_err(|err| RestError::internal(err.to_string()))?;
    // governance-01: a roleless account (no title, no 지점) is issued for by whoever
    // manages accounts; it carries no access of its own.
    let caller_manages_roleless = target_roles.is_empty()
        && authorize_capability(&principal, Action::new(Feature::UserManage)).is_ok();
    let target_branches =
        authorizable_target_branches(target_scope, caller_is_super_admin, caller_manages_roleless)?;

    // A branch-scoped target authorizes per-branch: `body.branch_id` is still
    // accepted for API stability but no longer grants access (it must be one of the
    // target's real branches), and the caller must be authorized for
    // `SubordinateUserCreate` against EVERY one of them. An org-wide target
    // (`None`) is authorized above (SUPER_ADMIN, org-wide) — no per-branch basis.
    if let Some(branches) = &target_branches {
        let requested_branch = BranchId::from_uuid(body.branch_id.ok_or_else(|| {
            RestError::bad_request("branch_id is required for a branch-scoped user")
        })?);
        if !branches.contains(&requested_branch) {
            return Err(RestError::forbidden(
                "branch_id does not belong to the target user",
            ));
        }
        for branch_id in branches {
            authorize(
                &principal,
                Action::limited(Feature::SubordinateUserCreate),
                *branch_id,
            )
            .map_err(|_| RestError::forbidden("not allowed to issue sign-in codes"))?;
        }
    }

    let ttl = resolve_otp_ttl(body.ttl_seconds)?;
    // Step-up: the caller proves possession of one of THEIR passkeys now, so a
    // stolen bearer token alone cannot mint a code (e.g. after a deactivation
    // swept the target's passkeys).
    let step_up = body.step_up.ok_or_else(|| {
        RestError::unauthorized(
            "issuing a sign-in code requires a step-up assertion of your passkey",
        )
    })?;
    services
        .passkeys
        .verify_step_up_for_user(
            &state.pool,
            step_up.ceremony_id,
            step_up.credential,
            *principal.user_id.as_uuid(),
        )
        .await
        .map_err(|err| passkey_error(err, "passkey step-up failed"))?;
    let now = OffsetDateTime::now_utc();
    let issue = services
        .bootstrap_credentials
        .issue_for_zero_credential_user(
            &state.pool,
            Some(principal.user_id),
            body.user_id,
            principal.org_id,
            now,
            ttl,
        )
        .await
        .map_err(RestError::from_provisioning)?;

    Ok(Json(AdminIssueOtpResponse {
        user_id: issue.user_id,
        otp: issue.token.as_str().to_owned(),
        expires_at: issue.expires_at,
    }))
}

/// Reset a locked-out user's credentials: revoke ALL their passkeys AND mint a
/// fresh single-use sign-in OTP, atomically and audited, so a user who lost their
/// only passkey can re-enroll.
///
/// This is the admin-only account-recovery escape hatch. The normal admin-OTP
/// path refuses a user who already has a passkey (409 `UserAlreadyHasPasskey`) and
/// self-revoke refuses the last passkey, so neither can recover a locked-out user;
/// this path deliberately overrides both — but ONLY for an admin, gated by the
/// EXACT same authz/IDOR rules as `issue_admin_otp`:
///   * Authz: ADMIN / SUPER_ADMIN via the `SubordinateUserCreate` feature against
///     EVERY one of the target's real branches.
///   * IDOR / cross-org: the target is read via `load_user_auth_context_in_org`
///     armed with the CALLER's verified-token org, so a user in another tenant is
///     invisible (a generic 403, no enumeration). A non-SUPER_ADMIN caller can
///     never reset an EXECUTIVE / SUPER_ADMIN target.
///
/// On success the OTP is shown once and the old passkeys fail login. Generic
/// errors only (no enumeration). One's own account: 409 `last_sign_in_path`.
pub(crate) async fn admin_credential_reset(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<AdminCredentialResetRequest>,
) -> Result<Json<AdminCredentialResetResponse>, RestError> {
    let services = state.services()?;
    let principal = principal_from_headers(&state.pool, services, &headers).await?;
    // governance-02: the sign-in path in use (the solo ops holder's lockout).
    if body.user_id == *principal.user_id.as_uuid() {
        return Err(RestError {
            status: axum::http::StatusCode::CONFLICT,
            code: "last_sign_in_path",
            message: "register a new passkey on another device first".to_owned(),
        });
    }
    // Same gate as `issue_admin_otp`: a caller without an enrolled passkey (an
    // OTP-only session) must not revoke passkeys and mint sign-in codes for
    // others. The enrollment-token layer already refuses OTP sessions; this
    // keeps the recovery escape hatch closed even without that layer.
    if !console_platform_auth::user_has_passkey(
        &state.pool,
        principal.org_id,
        *principal.user_id.as_uuid(),
    )
    .await
    .map_err(|err| RestError::internal(err.to_string()))?
    {
        return Err(RestError::passkey_required());
    }
    rate_limit_caller(
        &state.pool,
        *principal.user_id.as_uuid(),
        RateLimitEndpoint::AdminCredentialReset,
        OffsetDateTime::now_utc(),
    )
    .await?;

    // Resolve the TARGET's real roles inside the CALLER's tenant (IDOR / cross-org
    // guard): a user in another org is not visible under the caller's org GUC and
    // surfaces as the same generic 403 as a missing/inactive target.
    let target = load_user_auth_context_in_org(&state.pool, principal.org_id, body.user_id)
        .await
        .map_err(forbidden_if_unauthorized)?;
    let target_roles = parse_roles(&target.roles)?;

    let caller_is_super_admin = principal.roles.contains(&Role::SuperAdmin);

    // A non-SUPER_ADMIN caller may never reset a privileged target.
    let target_is_privileged = target_roles
        .iter()
        .any(|role| matches!(role, Role::Executive | Role::SuperAdmin));
    if target_is_privileged && !caller_is_super_admin {
        return Err(RestError::forbidden(
            "not allowed to reset credentials for a privileged user",
        ));
    }

    // Require the caller to be authorized against EVERY one of the target's real
    // branches, exactly like `issue_admin_otp`.
    let target_scope =
        resolve_branch_scope_in_org(&state.pool, principal.org_id, target.user_id, &target_roles)
            .await
            .map_err(|err| RestError::internal(err.to_string()))?;
    // governance-01: a roleless account (no title, no 지점) is issued for by whoever
    // manages accounts; it carries no access of its own.
    let caller_manages_roleless = target_roles.is_empty()
        && authorize_capability(&principal, Action::new(Feature::UserManage)).is_ok();
    let target_branches =
        authorizable_target_branches(target_scope, caller_is_super_admin, caller_manages_roleless)?;

    // Branch-scoped target → authorize the caller against EVERY one of the target's
    // real branches. Org-wide target (`None`) is authorized above (SUPER_ADMIN).
    if let Some(branches) = &target_branches {
        for branch_id in branches {
            authorize(
                &principal,
                Action::limited(Feature::SubordinateUserCreate),
                *branch_id,
            )
            .map_err(|_| RestError::forbidden("not allowed to reset credentials"))?;
        }
    }

    // Step-up: the caller proves possession of one of THEIR passkeys now, so a
    // stolen bearer token alone cannot reset someone and receive their code.
    let step_up = body.step_up.ok_or_else(|| {
        RestError::unauthorized(
            "resetting credentials requires a step-up assertion of your passkey",
        )
    })?;
    services
        .passkeys
        .verify_step_up_for_user(
            &state.pool,
            step_up.ceremony_id,
            step_up.credential,
            *principal.user_id.as_uuid(),
        )
        .await
        .map_err(|err| passkey_error(err, "passkey step-up failed"))?;

    let now = OffsetDateTime::now_utc();
    let issue = services
        .bootstrap_credentials
        .reset_credentials_for_user(
            &state.pool,
            principal.user_id,
            body.user_id,
            principal.org_id,
            now,
            DEFAULT_OTP_TTL,
        )
        .await
        .map_err(RestError::from_provisioning)?;

    Ok(Json(AdminCredentialResetResponse {
        user_id: issue.user_id,
        otp: issue.token.as_str().to_owned(),
        expires_at: issue.expires_at,
    }))
}
