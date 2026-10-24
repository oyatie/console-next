// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

/// Resolve a tenant [`Principal`] from an already-extracted bearer token.
///
/// Realtime WebSocket handshakes may carry the token in `Sec-WebSocket-Protocol`
/// rather than `Authorization`, but the security path after extraction must be
/// identical: verify, reject platform tier, parse roles/org/access scope,
/// re-resolve live branch memberships, and narrow by [`AccessScope`].
pub async fn resolve_principal_from_bearer_token(
    verifier: &JwtVerifier,
    pool: &PgPool,
    token: &str,
) -> Result<Principal, RequestContextError> {
    let claims = verifier
        .verify_access_token(token)
        .map_err(|_| RequestContextError::InvalidToken)?;

    // Tier separation: a PLATFORM token must NEVER resolve to a tenant principal.
    // Reject it here so a platform actor can never reach a tenant `/api/*` route
    // (and so its non-tenant `org` sentinel can never arm a real tenant GUC).
    if claims.platform {
        return Err(RequestContextError::WrongTokenTier);
    }

    let (user_id, org_id) = validate_current_claims(pool, &claims).await?;
    if let Some(session_id) = claims.support {
        return support::principal(pool, &claims, user_id, org_id, session_id)
            .await
            .map_err(|error| match error {
                console_platform_db::support::SupportError::Refused(_) => {
                    RequestContextError::InvalidToken
                }
                error => RequestContextError::EffectivePolicy(error.to_string()),
            });
    }
    // An OTP enrollment session reaches only the auth enrollment handlers,
    // which validate claims directly; every principal-resolved route (business
    // APIs, realtime) refuses it. 403, not 401: the caller is authenticated.
    if claims.enrollment {
        return Err(RequestContextError::AccessScope(KernelError::forbidden(
            PASSKEY_REQUIRED_MESSAGE,
        )));
    }
    let access_scope = claims
        .access_scope()
        .map_err(|_| RequestContextError::InvalidClaim("access scope is invalid"))?;
    let roles = claims
        .roles
        .iter()
        .map(|role| {
            Role::from_str(role).map_err(|_| RequestContextError::InvalidClaim("unknown role"))
        })
        .collect::<Result<BTreeSet<_>, _>>()?;

    // Preserve target-owned Cedar freshness. Delegated home-account freshness
    // was independently validated above; it must not replace this snapshot.
    let authz_freshness = SubjectFreshness {
        policy_version: claims.authz_policy_version,
        subject_version: claims.authz_subject_version,
        session_generation: claims.session_generation,
        step_up_generation: None,
    };

    if claims.tenant_context == Some(TenantAccessContext::GroupAdmin) {
        return resolve_group_admin_tenant_context_principal(
            pool,
            user_id,
            org_id,
            access_scope,
            roles,
            claims.group_context_id.as_deref(),
            authz_freshness,
        )
        .await;
    }

    let session = claims.session_family_id;
    access::tenant_principal(
        pool,
        user_id,
        org_id,
        roles,
        access_scope,
        authz_freshness,
        session,
    )
    .await
}

async fn resolve_group_admin_tenant_context_principal(
    pool: &PgPool,
    user_id: UserId,
    org_id: OrgId,
    access_scope: AccessScope,
    roles: BTreeSet<Role>,
    group_context_id: Option<&str>,
    authz_freshness: SubjectFreshness,
) -> Result<Principal, RequestContextError> {
    let expected_roles = BTreeSet::from([Role::Admin]);
    if roles != expected_roles {
        return Err(RequestContextError::InvalidClaim(
            "group-admin tenant context must carry only ADMIN",
        ));
    }
    let group_id = group_context_id
        .ok_or(RequestContextError::InvalidClaim(
            "group-admin tenant context is missing group id",
        ))?
        .parse::<uuid::Uuid>()
        .map_err(|_| RequestContextError::InvalidClaim("group id is not a valid uuid"))?;

    let members = group_admin_member_orgs(pool, group_id, user_id)
        .await
        .map_err(|err| RequestContextError::BranchScope(err.to_string()))?;
    if !members
        .iter()
        .any(|member| member.org_id == org_id && member.status == "ACTIVE")
    {
        return Err(RequestContextError::AccessScope(KernelError::forbidden(
            "group-admin tenant context is no longer authorized for this organization",
        )));
    }

    // The live group resolver proves the actor still administers this
    // subsidiary. Project through the token's scope so future narrower
    // hierarchy scopes cannot widen here, then build a bounded tenant principal:
    // ADMIN permissions, all-branch only for this subsidiary, never SUPER_ADMIN.
    let branch_scope = effective_branch_scope_for_tenant(BranchScope::All, access_scope, org_id)
        .map_err(RequestContextError::AccessScope)?;
    let effective_feature_grants =
        resolve_effective_feature_grants_in_org(pool, org_id, user_id, &branch_scope)
            .await
            .map_err(|err| RequestContextError::EffectivePolicy(err.to_string()))?;

    Ok(
        Principal::new(user_id, org_id, expected_roles, branch_scope)
            .with_access_scope(access_scope)
            .with_effective_feature_grants(effective_feature_grants)
            .with_authz_freshness(authz_freshness),
    )
}
