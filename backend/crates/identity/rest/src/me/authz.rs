use console_kernel_core::BranchScope;
use console_platform_authz::Action;
use console_platform_authz::Feature;
use console_platform_authz::PermissionLevel;
use console_platform_authz::Principal;
use console_platform_authz::authorize_org_wide;
use console_platform_authz::permission_for;
use serde::Serialize;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Authorization projection: GET /api/v1/me/authz (charter G-a)
// ---------------------------------------------------------------------------

/// The caller's authorization projection. NON-AUTHORITATIVE: `authority` is
/// always `advisory_ui_only` (mirroring `web/src/auth/policyProjection.ts`) —
/// the backend matrix (`authorize`) remains the sole enforcer; this only lets
/// the console render by grant instead of by hardcoded role lists (the class of
/// drift behind the ADMIN /overview 403 bug). `source = legacy_matrix` today;
/// the Cedar enforce-flip later flips it to `cedar` with this shape unchanged.
#[derive(Debug, Serialize)]
pub(crate) struct MeAuthzResponse {
    pub(crate) authority: &'static str,
    pub(crate) source: &'static str,
    pub(crate) user_id: Uuid,
    pub(crate) org_id: Uuid,
    /// Roles as principal attributes (canonical role keys).
    pub(crate) roles: Vec<String>,
    pub(crate) branch_scope: BranchScope,
    /// Capability grants the caller holds — deny-by-omission: a feature the
    /// caller cannot use at all is OMITTED, so `capabilities` is exactly the
    /// grant set the frontend checks against.
    pub(crate) capabilities: Vec<MeAuthzCapability>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct MeAuthzCapability {
    /// `Feature::as_str` snake_case key (matches `/api/v1/policy/features`).
    pub(crate) feature: String,
    /// `deny` is never emitted (omitted instead); one of `request_only`,
    /// `limited`, `allow`.
    pub(crate) permission: String,
    /// The branch subset this `permission` level actually holds over — NOT
    /// necessarily the caller's full `branch_scope`. A branch-narrowed custom
    /// grant (`EffectiveFeatureGrant::branch_scope`, already intersected with
    /// the caller's live scope by `resolve_effective_feature_grants_in_org`)
    /// only elevates the capability within its own branches; collapsing to a
    /// single scalar permission without this would over-promise the grant to
    /// every branch the caller can act in, an affordance the real `authorize`
    /// call would then 403 outside this scope — the exact class of drift this
    /// endpoint exists to fix. The UI must intersect this with its target
    /// branch before offering the affordance.
    pub(crate) branch_scope: BranchScope,
    /// Whether the caller passes the ORG-WIDE gate for this feature
    /// (`authorize_org_wide` at `allow`): all-branch scope, held by
    /// SUPER_ADMIN/EXECUTIVE or an org-wide custom grant. Org-wide screens with
    /// no branch in the request (e.g. period locks) must gate on this, not on
    /// `branch_scope`, which only says where per-branch actions hold.
    pub(crate) org_wide: bool,
    /// AX-5: held over part of the tenant through access grants, so the
    /// per-resource doors admit the caller inside that scope. Whole-tenant
    /// doors refuse it (`scope_tenant_wide_only`): gate those on `org_wide`.
    pub(crate) scoped: bool,
}

pub(crate) fn permission_rank(level: PermissionLevel) -> u8 {
    match level {
        PermissionLevel::Deny => 0,
        PermissionLevel::RequestOnly => 1,
        PermissionLevel::Limited => 2,
        PermissionLevel::Allow => 3,
    }
}

pub(crate) fn branch_scope_union(a: &BranchScope, b: &BranchScope) -> BranchScope {
    match (a, b) {
        (BranchScope::All, _) | (_, BranchScope::All) => BranchScope::All,
        (BranchScope::Branches(x), BranchScope::Branches(y)) => {
            BranchScope::Branches(x.union(y).copied().collect())
        }
    }
}

/// The caller's effective permission for one feature, paired with the branch
/// subset it holds over — exactly the `OR` the enforcer (`authorize`)
/// evaluates, projected to a single (level, scope) pair. Built-in roles hold
/// uniformly across the caller's full `branch_scope` (`authorize` never
/// branch-narrows a role permission beyond the principal's own scope). A
/// custom grant only elevates the capability within `grant.branch_scope`
/// (already the live-scope-intersected effective set) — a lower-ranked grant
/// never widens the current best scope, and an equal-ranked grant unions in
/// (there can be more than one branch-narrowed grant for the same feature).
pub(crate) fn feature_capability(
    principal: &Principal,
    feature: Feature,
) -> Option<(PermissionLevel, BranchScope)> {
    let role_level = principal
        .roles
        .iter()
        .map(|role| permission_for(*role, feature))
        .max_by_key(|level| permission_rank(*level))
        .unwrap_or(PermissionLevel::Deny);
    let mut best = role_level;
    let mut best_scope = principal.branch_scope.clone();

    for grant in principal
        .effective_feature_grants
        .iter()
        .filter(|grant| grant.feature == feature)
    {
        match permission_rank(grant.permission).cmp(&permission_rank(best)) {
            std::cmp::Ordering::Greater => {
                best = grant.permission;
                best_scope = grant.branch_scope.clone();
            }
            std::cmp::Ordering::Equal => {
                best_scope = branch_scope_union(&best_scope, &grant.branch_scope);
            }
            std::cmp::Ordering::Less => {}
        }
    }

    (best != PermissionLevel::Deny).then_some((best, best_scope))
}

pub(crate) fn me_authz_projection(principal: &Principal) -> MeAuthzResponse {
    let capabilities = Feature::ALL
        .into_iter()
        .filter_map(|feature| {
            let (level, scope) = feature_capability(principal, feature)?;
            let org_wide = authorize_org_wide(principal, Action::new(feature)).is_ok();
            Some(MeAuthzCapability {
                feature: feature.as_str().to_owned(),
                permission: level.as_str().to_owned(),
                branch_scope: scope,
                scoped: !org_wide && principal.scopes_for(feature).next().is_some(),
                org_wide,
            })
        })
        .collect();
    MeAuthzResponse {
        authority: "advisory_ui_only",
        source: "legacy_matrix",
        user_id: *principal.user_id.as_uuid(),
        org_id: *principal.org_id.as_uuid(),
        roles: principal
            .roles
            .iter()
            .map(|role| role.as_str().to_owned())
            .collect(),
        branch_scope: principal.branch_scope.clone(),
        capabilities,
    }
}

/// Served module capabilities inherit their owning Cedar permission.
pub(crate) fn served_authz_projection(principal: &Principal, documents: bool) -> MeAuthzResponse {
    let mut response = me_authz_projection(principal);
    if documents
        && let Some(cap) = response
            .capabilities
            .iter()
            .find(|cap| cap.feature == Feature::EvidenceAttach.as_str())
            .cloned()
    {
        response.capabilities.push(MeAuthzCapability {
            feature: "documents".to_owned(),
            ..cap
        });
    }
    response
}

#[cfg(test)]
mod me_authz_org_wide_tests {
    use super::*;
    use console_kernel_core::BranchId;
    use console_kernel_core::BranchScope;
    use console_kernel_core::OrgId;
    use console_kernel_core::UserId;
    use console_platform_authz::EffectiveFeatureGrant;
    use console_platform_authz::Feature;
    use console_platform_authz::PermissionLevel;
    use console_platform_authz::Principal;
    use console_platform_authz::Role;
    use std::collections::BTreeSet;

    #[test]
    fn documents_require_both_a_served_binary_and_the_owning_permission() {
        let admin = Principal::new(
            UserId::new(),
            OrgId::one(),
            BTreeSet::from([Role::SuperAdmin]),
            BranchScope::All,
        );
        let contains = |p: &Principal, served| {
            served_authz_projection(p, served)
                .capabilities
                .iter()
                .any(|cap| cap.feature == "documents")
        };
        assert!(!contains(&admin, false));
        assert!(contains(&admin, true));
        let no_roles = Principal::new(
            UserId::new(),
            OrgId::one(),
            BTreeSet::new(),
            BranchScope::All,
        );
        assert!(!contains(&no_roles, true));
    }

    fn period_lock(principal: &Principal) -> Option<bool> {
        me_authz_projection(principal)
            .capabilities
            .into_iter()
            .find(|cap| cap.feature == "period_lock_manage")
            .map(|cap| cap.org_wide)
    }

    /// `org_wide` is exactly the org-wide period-lock handler's gate.
    #[test]
    fn org_wide_matches_the_org_wide_gate() {
        let branch = BranchId::new();
        let admin = Principal::new(
            UserId::new(),
            OrgId::one(),
            BTreeSet::from([Role::Admin]),
            BranchScope::single(branch),
        );
        // A branch ADMIN holds period_lock_manage per branch (attendance close),
        // but the org-wide period-lock screen refuses it.
        assert_eq!(period_lock(&admin), Some(false));
        for role in [Role::SuperAdmin, Role::Executive] {
            let leader = Principal::new(
                UserId::new(),
                OrgId::one(),
                BTreeSet::from([role]),
                BranchScope::All,
            );
            assert_eq!(period_lock(&leader), Some(true), "{role:?}");
        }
        // An org-wide custom grant at `limited` is advertised (limited, all) but the
        // handler needs `allow`, so it is not org-wide.
        let limited = Principal::new(
            UserId::new(),
            OrgId::one(),
            BTreeSet::from([Role::Member]),
            BranchScope::All,
        )
        .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
            Feature::PeriodLockManage,
            PermissionLevel::Limited,
            BranchScope::All,
        )]);
        assert_eq!(period_lock(&limited), Some(false));
    }
}
