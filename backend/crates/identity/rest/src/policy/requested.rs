use crate::error::RestError;
use console_identity_application::PolicyRoleAssignmentSummary;
use console_identity_application::PolicyRoleSummary;
use console_platform_authz::Feature;
use std::collections::BTreeSet;
use uuid::Uuid;

pub(crate) fn validate_requested_policy_roles(
    custom_roles: &[PolicyRoleSummary],
    raw_role_ids: &[Uuid],
) -> Result<Vec<PolicyRoleSummary>, RestError> {
    let requested_ids = raw_role_ids.iter().copied().collect::<BTreeSet<_>>();
    let mut roles = Vec::with_capacity(requested_ids.len());
    for requested_id in requested_ids {
        let Some(role) = custom_roles
            .iter()
            .find(|role| role.id == requested_id && !role.is_system && role.status != "RETIRED")
        else {
            return Err(RestError::validation(
                "preview references an unknown or retired custom role",
            ));
        };
        roles.push(role.clone());
    }
    Ok(roles)
}

pub(crate) fn policy_roles_touched_by_assignment_replace(
    custom_roles: &[PolicyRoleSummary],
    requested_roles: &[PolicyRoleSummary],
    current_assignments: &[PolicyRoleAssignmentSummary],
) -> Result<Vec<PolicyRoleSummary>, RestError> {
    let requested_ids = requested_roles
        .iter()
        .map(|role| role.id)
        .collect::<BTreeSet<_>>();
    let mut roles = requested_roles.to_vec();
    for removed_id in current_assignments
        .iter()
        .map(|assignment| assignment.role_id)
        .collect::<BTreeSet<_>>()
        .difference(&requested_ids)
        .copied()
    {
        let Some(role) = custom_roles
            .iter()
            .find(|role| role.id == removed_id && !role.is_system)
        else {
            return Err(RestError::validation(
                "assignment references an unknown custom role",
            ));
        };
        roles.push(role.clone());
    }
    Ok(roles)
}

pub(crate) fn reject_new_ai_role_assignments(
    requested_roles: &[PolicyRoleSummary],
    current_assignments: &[PolicyRoleAssignmentSummary],
) -> Result<(), RestError> {
    let current_ids = current_assignments
        .iter()
        .map(|assignment| assignment.role_id)
        .collect::<BTreeSet<_>>();
    if requested_roles.iter().any(|role| {
        !current_ids.contains(&role.id)
            && role
                .permissions
                .iter()
                .any(|permission| permission.feature_key == Feature::AiAssist.as_str())
    }) {
        return Err(RestError::forbidden(
            "retired AI roles cannot be newly assigned",
        ));
    }
    Ok(())
}
