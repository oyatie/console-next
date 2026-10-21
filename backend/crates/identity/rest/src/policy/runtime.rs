use crate::error::RestError;
use console_identity_application::PolicyRoleCondition;
use console_identity_application::PolicyRolePermission;
use console_identity_application::PolicyRoleSummary;
use console_identity_application::UserSummary;
use console_identity_domain::Team;
use console_kernel_core::BranchId;
use console_kernel_core::BranchScope;
use console_platform_authz::Feature;
use console_platform_authz::PermissionLevel;
use console_platform_authz::Role;
use console_platform_authz::custom_role_runtime_feature_allowed;
use std::collections::BTreeSet;
use std::str::FromStr;

pub(crate) fn normalize_policy_role_status(raw: &str) -> Result<String, RestError> {
    let status = raw.trim().to_ascii_uppercase();
    match status.as_str() {
        "DRAFT" | "ACTIVE" | "RETIRED" => Ok(status),
        _ => Err(RestError::validation(
            "policy role status must be DRAFT, ACTIVE, or RETIRED",
        )),
    }
}

pub(crate) fn validate_policy_role_status_transition(
    current_status: &str,
    requested_status: &str,
) -> Result<(), RestError> {
    if current_status == requested_status {
        return Ok(());
    }
    match (current_status, requested_status) {
        ("DRAFT", "ACTIVE") | ("ACTIVE", "DRAFT") | ("ACTIVE", "RETIRED") => Ok(()),
        _ => Err(RestError::validation(
            "policy role status transition is not allowed",
        )),
    }
}

pub(crate) fn normalize_policy_audit_limit(raw: Option<i64>) -> Result<i64, RestError> {
    let limit = raw.unwrap_or(20);
    if !(1..=100).contains(&limit) {
        return Err(RestError::validation(
            "policy audit limit must be between 1 and 100",
        ));
    }
    Ok(limit)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PolicyRoleRuntimeDecision {
    pub(crate) effective: bool,
    pub(crate) warnings: Vec<String>,
}

pub(crate) fn policy_role_runtime_decision_for_user(
    role: &PolicyRoleSummary,
    user: &UserSummary,
) -> PolicyRoleRuntimeDecision {
    let mut warnings = Vec::new();

    if role.status != "ACTIVE" {
        warnings.push("custom_role_status_not_active".to_owned());
    }

    let live_scope = policy_preview_branch_scope_for_user(user);
    match effective_scope_for_policy_preview_conditions(user, &live_scope, &role.conditions) {
        Ok(role_scope) if role_scope.is_empty() => {
            warnings.push("custom_role_condition_outside_target_branch_scope".to_owned());
        }
        Ok(_) => {}
        Err(reason) => warnings.push(reason.to_owned()),
    }

    if runtime_allowed_policy_permissions(role).is_empty() {
        warnings.push("custom_role_no_runtime_allowed_permissions".to_owned());
    }

    PolicyRoleRuntimeDecision {
        effective: warnings.is_empty(),
        warnings,
    }
}

pub(crate) fn runtime_allowed_policy_permissions(
    role: &PolicyRoleSummary,
) -> Vec<&PolicyRolePermission> {
    role.permissions
        .iter()
        .filter(|permission| {
            let Ok(feature) = Feature::from_str(&permission.feature_key) else {
                return false;
            };
            let Ok(level) = PermissionLevel::from_str(&permission.permission_level) else {
                return false;
            };
            level != PermissionLevel::Deny && custom_role_runtime_feature_allowed(feature)
        })
        .collect()
}

pub(crate) fn policy_preview_branch_scope_for_user(user: &UserSummary) -> BranchScope {
    let has_org_wide_system_role = user
        .roles
        .iter()
        .filter_map(|role| Role::from_str(role).ok())
        .any(|role| matches!(role, Role::Executive | Role::SuperAdmin));
    if has_org_wide_system_role {
        return BranchScope::All;
    }

    BranchScope::Branches(user.branch_ids.iter().copied().collect())
}

pub(crate) fn effective_scope_for_policy_preview_conditions(
    user: &UserSummary,
    live_scope: &BranchScope,
    conditions: &[PolicyRoleCondition],
) -> Result<BranchScope, &'static str> {
    let mut scope = live_scope.clone();
    for condition in conditions {
        if !matches!(condition.operator.as_str(), "equals" | "in") {
            return Err("custom_role_condition_unsupported_by_runtime_evaluator");
        }

        match condition.attribute.as_str() {
            "branch" => {
                let mut branches = BTreeSet::new();
                for value in &condition.values {
                    let branch = BranchId::from_str(value)
                        .map_err(|_| "custom_role_condition_invalid_branch_value")?;
                    branches.insert(branch);
                }
                scope = scope.intersect(&BranchScope::Branches(branches));
            }
            "team" => {
                if !team_condition_matches(user.team, &condition.values) {
                    return Err("custom_role_condition_outside_target_attributes");
                }
            }
            _ => return Err("custom_role_condition_unsupported_by_runtime_evaluator"),
        }
    }
    Ok(scope)
}

pub(crate) fn team_condition_matches(team: Option<Team>, values: &[String]) -> bool {
    let Some(team) = team else {
        return false;
    };
    let accepted = team_policy_values(team);
    values.iter().any(|value| {
        let value = value.trim();
        accepted
            .iter()
            .any(|accepted| value == *accepted || value.eq_ignore_ascii_case(accepted))
    })
}

pub(crate) fn team_policy_values(team: Team) -> [&'static str; 2] {
    match team {
        Team::Maintenance => ["MAINTENANCE", Team::Maintenance.as_db_str()],
        Team::Prevention => ["PREVENTION", Team::Prevention.as_db_str()],
        Team::Management => ["MANAGEMENT", Team::Management.as_db_str()],
        Team::Reception => ["RECEPTION", Team::Reception.as_db_str()],
    }
}

/// Policy Studio UI catalog / GET-response visibility — narrower than the
/// runtime safety predicate [`custom_role_runtime_feature_allowed`].
///
/// V1 retains the historical AI wire key for persisted policy evidence, but
/// never exposes it as a current permission or catalog affordance. Runtime
/// grant folding and write validation use the authz safety predicate.
pub(crate) fn policy_studio_feature_visible(feature: Feature) -> bool {
    !matches!(
        feature,
        Feature::AiAssist | Feature::AuditStreamRead | Feature::AuditStreamAccessLogRead
    )
}

pub(crate) fn policy_feature_key_visible(feature_key: &str) -> bool {
    Feature::from_str(feature_key)
        .map(policy_studio_feature_visible)
        .unwrap_or(true)
}

pub(crate) fn is_elevated_policy_feature(feature: Feature) -> bool {
    !custom_role_runtime_feature_allowed(feature)
}
