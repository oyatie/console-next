use crate::error::RestError;
use crate::metrics::record_policy_studio_rejection;
use console_identity_application::PolicyRoleCondition;
use console_identity_application::PolicyRoleSummary;
use console_kernel_core::BranchId;
use console_kernel_core::BranchScope;
use console_platform_authz::Feature;
use console_platform_authz::PermissionLevel;
use console_platform_authz::Principal;
use console_platform_authz::Role;
use console_platform_authz::custom_role_runtime_feature_allowed;
use console_platform_authz::permission_for;
use std::collections::BTreeSet;
use std::str::FromStr;
use uuid::Uuid;

pub(crate) fn ensure_policy_roles_inside_delegated_authority_for_operation(
    operation: &'static str,
    principal: &Principal,
    roles: &[PolicyRoleSummary],
) -> Result<(), RestError> {
    for role in roles {
        if let Err(error) =
            ensure_policy_conditions_inside_delegated_authority(principal, &role.conditions)
        {
            record_policy_studio_rejection(operation, principal, &error);
            return Err(error);
        }
    }
    Ok(())
}

pub(crate) fn ensure_policy_roles_inside_actor_permission_ceiling_for_operation(
    operation: &'static str,
    principal: &Principal,
    roles: &[PolicyRoleSummary],
) -> Result<(), RestError> {
    if let Err(error) = ensure_policy_roles_inside_actor_permission_ceiling(principal, roles) {
        record_policy_studio_rejection(operation, principal, &error);
        return Err(error);
    }
    Ok(())
}

pub(crate) fn ensure_policy_roles_inside_actor_permission_ceiling(
    principal: &Principal,
    roles: &[PolicyRoleSummary],
) -> Result<(), RestError> {
    for role in roles {
        let role_scope = policy_role_assignment_branch_scope(principal, role)?;
        for permission in &role.permissions {
            let feature = Feature::from_str(&permission.feature_key)
                .map_err(|_| RestError::validation("unknown feature key"))?;
            if feature == Feature::AiAssist {
                continue;
            }
            let requested = PermissionLevel::from_str(&permission.permission_level)
                .map_err(|_| RestError::validation("unknown permission level"))?;
            if matches!(requested, PermissionLevel::Deny) {
                continue;
            }
            if !custom_role_runtime_feature_allowed(feature) {
                return Err(RestError::forbidden(
                    "custom roles cannot grant elevated or scope-widening policy features yet",
                ));
            }
            if policy_feature_assignment_requires_elevated_grant(feature)
                && !principal_holds_policy_permission(
                    principal,
                    Feature::ElevatedRoleGrant,
                    PermissionLevel::Allow,
                    &role_scope,
                )
            {
                return Err(RestError::forbidden(
                    "elevated policy role assignments require elevated role grant",
                ));
            }
            if !principal_holds_policy_permission(principal, feature, requested, &role_scope) {
                return Err(RestError::forbidden(
                    "policy role permission exceeds delegated authority",
                ));
            }
        }
    }
    Ok(())
}

pub(crate) fn policy_role_assignment_branch_scope(
    principal: &Principal,
    role: &PolicyRoleSummary,
) -> Result<BranchScope, RestError> {
    let mut scope = principal.branch_scope.clone();
    for condition in role
        .conditions
        .iter()
        .filter(|condition| condition.attribute == "branch")
    {
        if !matches!(condition.operator.as_str(), "equals" | "in") {
            // Unsupported branch operators are not a safe narrowing proof. Keep
            // the current scope rather than assuming the role is branch-limited.
            continue;
        }
        let mut branches = BTreeSet::new();
        for value in &condition.values {
            let branch_uuid = Uuid::parse_str(value).map_err(|_| {
                RestError::validation(
                    "branch condition values must be branch UUIDs for delegated policy management",
                )
            })?;
            branches.insert(BranchId::from_uuid(branch_uuid));
        }
        scope = scope.intersect(&BranchScope::Branches(branches));
    }
    Ok(scope)
}

pub(crate) fn principal_holds_policy_permission(
    principal: &Principal,
    feature: Feature,
    requested: PermissionLevel,
    scope: &BranchScope,
) -> bool {
    principal.roles.iter().any(|role| {
        policy_permission_satisfies(permission_for(*role, feature), requested)
            && branch_scope_contains(&principal.branch_scope, scope)
    }) || principal.effective_feature_grants.iter().any(|grant| {
        grant.feature == feature
            && policy_permission_satisfies(grant.permission, requested)
            && branch_scope_contains(&grant.branch_scope, scope)
    })
}

pub(crate) fn policy_permission_satisfies(
    held: PermissionLevel,
    requested: PermissionLevel,
) -> bool {
    match requested {
        PermissionLevel::Deny => true,
        PermissionLevel::Allow => matches!(held, PermissionLevel::Allow),
        PermissionLevel::Limited => {
            matches!(held, PermissionLevel::Allow | PermissionLevel::Limited)
        }
        PermissionLevel::RequestOnly => {
            matches!(held, PermissionLevel::Allow | PermissionLevel::RequestOnly)
        }
    }
}

pub(crate) fn branch_scope_contains(container: &BranchScope, contained: &BranchScope) -> bool {
    match (container, contained) {
        (BranchScope::All, _) => true,
        (BranchScope::Branches(_), BranchScope::All) => false,
        (BranchScope::Branches(container), BranchScope::Branches(contained)) => {
            contained.is_subset(container)
        }
    }
}

pub(crate) fn policy_feature_assignment_requires_elevated_grant(feature: Feature) -> bool {
    if matches!(feature, Feature::UserManage) {
        return true;
    }
    let super_admin_allows = permission_for(Role::SuperAdmin, feature) == PermissionLevel::Allow;
    let non_super_admin_allows = Role::ALL
        .into_iter()
        .filter(|role| *role != Role::SuperAdmin)
        .any(|role| permission_for(role, feature) == PermissionLevel::Allow);
    super_admin_allows && !non_super_admin_allows
}

pub(crate) fn ensure_policy_conditions_inside_delegated_authority_for_operation(
    operation: &'static str,
    principal: &Principal,
    conditions: &[PolicyRoleCondition],
) -> Result<(), RestError> {
    if let Err(error) = ensure_policy_conditions_inside_delegated_authority(principal, conditions) {
        record_policy_studio_rejection(operation, principal, &error);
        return Err(error);
    }
    Ok(())
}

pub(crate) fn policy_role_is_inside_delegated_authority(
    principal: &Principal,
    role: &PolicyRoleSummary,
) -> bool {
    ensure_policy_conditions_inside_delegated_authority(principal, &role.conditions).is_ok()
}

pub(crate) fn ensure_policy_conditions_inside_delegated_authority(
    principal: &Principal,
    conditions: &[PolicyRoleCondition],
) -> Result<(), RestError> {
    let BranchScope::Branches(allowed_branches) = &principal.branch_scope else {
        return Ok(());
    };
    if allowed_branches.is_empty() {
        return Err(RestError::forbidden(
            "delegated policy managers must have at least one branch in scope",
        ));
    }

    let branch_conditions = conditions
        .iter()
        .filter(|condition| condition.attribute == "branch")
        .collect::<Vec<_>>();
    if branch_conditions.is_empty() {
        return Err(RestError::forbidden(
            "branch-scoped policy managers must include a branch condition",
        ));
    }

    for condition in branch_conditions {
        if condition.operator == "not_equals" {
            return Err(RestError::forbidden(
                "branch-scoped policy managers cannot use negative branch conditions",
            ));
        }
        for value in &condition.values {
            let branch_uuid = Uuid::parse_str(value).map_err(|_| {
                RestError::validation(
                    "branch condition values must be branch UUIDs for delegated policy management",
                )
            })?;
            let branch_id = BranchId::from_uuid(branch_uuid);
            if !allowed_branches.contains(&branch_id) {
                return Err(RestError::forbidden(
                    "policy role branch condition is outside delegated scope",
                ));
            }
        }
    }

    Ok(())
}

pub(crate) fn ensure_assignment_preview_acknowledged(
    principal: &Principal,
    preview_acknowledged: bool,
) -> Result<(), RestError> {
    if preview_acknowledged {
        return Ok(());
    }
    let error = RestError::validation("assignment preview must be acknowledged before saving");
    record_policy_studio_rejection("replace_assignments", principal, &error);
    Err(error)
}

pub(crate) fn require_assignment_preview_receipt(
    principal: &Principal,
    preview_receipt_id: Option<Uuid>,
) -> Result<Uuid, RestError> {
    let Some(preview_receipt_id) = preview_receipt_id else {
        let error = RestError::validation("assignment preview receipt is required before saving");
        record_policy_studio_rejection("replace_assignments", principal, &error);
        return Err(error);
    };
    Ok(preview_receipt_id)
}
