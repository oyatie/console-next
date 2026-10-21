use crate::authz::authorize_org_manage;
use crate::error::RestError;
use axum::http::StatusCode;
use console_kernel_core::BranchId;
use console_kernel_core::BranchScope;
use console_platform_authz::Action;
use console_platform_authz::Feature;
use console_platform_authz::Principal;
use console_platform_authz::Role;
use console_platform_authz::authorize;
use console_platform_authz::authorize_capability;
use std::collections::BTreeSet;
use std::str::FromStr;

/// Authorize a user create/update for elevated-role membership changes and
/// branch membership mutations, mirroring the `issue_admin_otp` IDOR hardening:
///   * Adding OR removing EXECUTIVE/SUPER_ADMIN requires `ElevatedRoleGrant`
///     (SUPER_ADMIN). Preserving an existing elevated role while changing other
///     fields must not block a branch admin from granting ordinary branch
///     permissions such as ADMIN to an existing executive.
///   * Otherwise the caller needs `SubordinateUserCreate` (limited) in EVERY
///     branch in the union of `current_branches` and `target_branches`, so a
///     branch-scoped admin cannot mint users into — or strip users from —
///     branches outside their scope (console-0lj). Pass `&[]` for create.
pub(crate) fn authorize_user_write(
    principal: &Principal,
    elevated_role_changes: &BTreeSet<Role>,
    current_branches: &[BranchId],
    target_branches: &[BranchId],
) -> Result<(), RestError> {
    // Baseline user-management authority.
    authorize_org_manage(principal, Feature::UserManage)?;

    if !elevated_role_changes.is_empty() {
        // Only SUPER_ADMIN holds ElevatedRoleGrant; checked org-globally.
        return authorize_capability(principal, Action::new(Feature::ElevatedRoleGrant))
            .map_err(|_| RestError::forbidden("not allowed to change elevated roles"));
    }

    // Non-privileged user: cross-branch principals are already covered by the
    // UserManage check above; branch-scoped principals must additionally hold
    // SubordinateUserCreate in every branch the membership touches (add OR
    // remove). Union is deliberate: authorizing only the post-state set left
    // removals ungated (console-0lj).
    if matches!(principal.branch_scope, BranchScope::All) {
        return Ok(());
    }
    let mut touched = BTreeSet::new();
    for branch_id in current_branches.iter().chain(target_branches.iter()) {
        touched.insert(*branch_id);
    }
    for branch_id in touched {
        authorize(
            principal,
            Action::limited(Feature::SubordinateUserCreate),
            branch_id,
        )
        .map_err(|_| RestError::forbidden("not allowed to manage users in that branch"))?;
    }
    Ok(())
}

/// The accounts a caller may list and open: where its 권한 관리 (`UserManage`)
/// authority holds — a role over the caller's scope, a tenant role grant over
/// the grant's own scope (회사 전체 = every account) — never the data scope
/// another grant gives (governance-02: a 법인 인사 grant must not hide the
/// roleless accounts a 회사 전체 권한 관리 grant manages).
pub(crate) fn account_scope(principal: &Principal) -> BranchScope {
    crate::me::authz::feature_capability(principal, Feature::UserManage)
        .map_or_else(|| principal.branch_scope.clone(), |(_, scope)| scope)
}

/// governance-01 (#19, #18): no preset roles and no title-implied access. An
/// invite creates an account with NO access, and an account never gains a
/// legacy role or 지점 membership again; removing one stays allowed so legacy
/// accounts can be cleaned. Access comes only from tenant roles granted under
/// `/access/grants` (Cedar, fail closed).
pub(crate) fn refuse_added_access(
    current_roles: &[String],
    requested_roles: Option<&[String]>,
    current_branches: &[BranchId],
    requested_branches: Option<&[BranchId]>,
) -> Result<(), RestError> {
    if requested_roles.is_some_and(|r| r.iter().any(|role| !current_roles.contains(role))) {
        return Err(RestError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "preset_role_refused",
            "preset roles are retired: grant a tenant role under 권한 instead",
        ));
    }
    if requested_branches.is_some_and(|b| b.iter().any(|id| !current_branches.contains(id))) {
        return Err(RestError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "branch_membership_refused",
            "지점 memberships are retired: a tenant role's scope says where access holds",
        ));
    }
    Ok(())
}

/// governance-22: the tenant's ops account is never deactivated and never has
/// its roles changed here (lockout invariant; its holder changes only through
/// the vendor-assisted 운영 계정 인계).
pub(crate) fn refuse_ops_target(is_tenant_ops: bool) -> Result<(), RestError> {
    if is_tenant_ops {
        return Err(RestError::new(
            StatusCode::CONFLICT,
            "ops_account_protected",
            "the ops account cannot be deactivated or given a role; its holder changes by 운영 계정 인계",
        ));
    }
    Ok(())
}

pub(crate) fn elevated_roles_in(roles: &BTreeSet<Role>) -> BTreeSet<Role> {
    roles
        .iter()
        .copied()
        .filter(|role| matches!(role, Role::Executive | Role::SuperAdmin))
        .collect()
}

pub(crate) fn elevated_role_membership_changes(
    current_roles: &[String],
    requested_roles: Option<&BTreeSet<Role>>,
) -> Result<BTreeSet<Role>, RestError> {
    let Some(requested_roles) = requested_roles else {
        return Ok(BTreeSet::new());
    };
    let current_roles = parse_roles(current_roles)?;
    Ok(elevated_roles_in(&current_roles)
        .symmetric_difference(&elevated_roles_in(requested_roles))
        .copied()
        .collect())
}

/// Parse and validate role strings against the authz matrix. Empty role sets are
/// permitted (a user with no roles still exists and can sign in via Login only
/// once roles are added).
pub(crate) fn parse_roles(raw: &[String]) -> Result<BTreeSet<Role>, RestError> {
    raw.iter()
        .map(|role| {
            Role::from_str(role)
                .map_err(|_| RestError::validation(format!("unknown role {role:?}")))
        })
        .collect()
}

pub(crate) fn role_db_strings(roles: &BTreeSet<Role>) -> Vec<String> {
    roles.iter().map(|role| role.as_str().to_owned()).collect()
}

/// Whether the requested role SET differs from the stored `users.roles` array
/// (console-9sb).
///
/// `users.roles` is stored in [`Role`]'s derived (DECLARATION) order, while a
/// client echoes the array in any order it was given. Comparing the two as
/// SEQUENCES therefore misreports an unchanged role set in a different order as
/// a change (and a lexicographic `sort()` of the stored strings disagrees with
/// `Role`'s declaration order even further). Both sides are normalised to a set
/// so only a real membership change counts, matching the adapter's
/// `normalize_system_roles` semantics.
pub(crate) fn system_roles_changed(requested: &BTreeSet<Role>, current: &[String]) -> bool {
    let requested: BTreeSet<String> = role_db_strings(requested).into_iter().collect();
    let current: BTreeSet<String> = current.iter().cloned().collect();
    requested != current
}

#[cfg(test)]
mod authorize_user_write_tests {
    use super::*;
    use axum::http::StatusCode;
    use console_kernel_core::BranchId;
    use console_kernel_core::BranchScope;
    use console_kernel_core::OrgId;
    use console_kernel_core::UserId;
    use console_platform_authz::Principal;
    use console_platform_authz::Role;
    use std::collections::BTreeSet;

    fn admin_in(branches: impl IntoIterator<Item = BranchId>) -> Principal {
        Principal::new(
            UserId::new(),
            OrgId::one(),
            BTreeSet::from([Role::Admin]),
            BranchScope::Branches(branches.into_iter().collect()),
        )
    }

    /// console-0lj: a Branches({A}) admin must not drop U from B by PATCHing
    /// branch_ids to [A] alone. The guard authorizes the union of current and
    /// requested sets; post-state-only authorization is the live defect.
    #[test]
    fn refuses_branch_removal_outside_caller_scope() {
        let branch_a = BranchId::new();
        let branch_b = BranchId::new();
        let principal = admin_in([branch_a]);
        let err = authorize_user_write(
            &principal,
            &BTreeSet::new(),
            &[branch_a, branch_b],
            &[branch_a],
        )
        .expect_err("removing B without SubordinateUserCreate in B must fail");
        assert_eq!(err.status, StatusCode::FORBIDDEN);
        assert_eq!(err.code, "forbidden");
        assert_eq!(err.message, "not allowed to manage users in that branch");
    }

    #[test]
    fn allows_in_scope_membership_rewrite() {
        let branch_a = BranchId::new();
        let principal = admin_in([branch_a]);
        authorize_user_write(&principal, &BTreeSet::new(), &[branch_a], &[branch_a])
            .expect("in-scope rewrite must pass");
    }

    #[test]
    fn still_refuses_branch_addition_outside_caller_scope() {
        let branch_a = BranchId::new();
        let branch_b = BranchId::new();
        let principal = admin_in([branch_a]);
        let err = authorize_user_write(
            &principal,
            &BTreeSet::new(),
            &[branch_a],
            &[branch_a, branch_b],
        )
        .expect_err("adding B without SubordinateUserCreate in B must fail");
        assert_eq!(err.status, StatusCode::FORBIDDEN);
    }
}

#[cfg(test)]
mod system_roles_changed_tests {
    use super::*;
    use console_platform_authz::Role;
    use std::collections::BTreeSet;

    /// console-9sb: `users.roles` is stored in `Role`'s DECLARATION order
    /// (`SUPER_ADMIN`, `ADMIN`, ...), but a lexicographic sort yields
    /// (`ADMIN`, `SUPER_ADMIN`). Comparing the two as sequences misreports an
    /// unchanged set as changed. The comparison must be order-insensitive.
    #[test]
    fn unchanged_role_set_in_a_different_order_is_not_a_change() {
        let requested: BTreeSet<Role> = [Role::SuperAdmin, Role::Admin].into_iter().collect();
        // The stored array echoed back in lexicographic order — the reverse of
        // `Role`'s declaration order.
        let current = vec!["ADMIN".to_owned(), "SUPER_ADMIN".to_owned()];
        assert!(
            !system_roles_changed(&requested, &current),
            "the same role set in a different order must not be a change"
        );
    }

    /// An actual membership change is still a change.
    #[test]
    fn role_set_membership_difference_is_a_change() {
        let requested: BTreeSet<Role> = [Role::SuperAdmin, Role::Admin].into_iter().collect();
        let current = vec!["ADMIN".to_owned()];
        assert!(system_roles_changed(&requested, &current));
    }
}
