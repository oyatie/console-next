use crate::error::RestError;
use crate::policy::dto::PolicyConditionResponse;
use crate::policy::dto::PolicyPermissionResponse;
use console_identity_application::PolicyRoleCondition;
use console_identity_application::PolicyRolePermission;
use console_platform_authz::Feature;
use console_platform_authz::PermissionLevel;
use console_platform_authz::Role;
use console_platform_authz::custom_role_runtime_feature_allowed;
use std::collections::BTreeSet;
use std::str::FromStr;

pub(crate) fn normalize_policy_role_key(raw: &str) -> Result<String, RestError> {
    let value = raw.trim();
    if value.len() < 2 || value.len() > 64 {
        return Err(RestError::validation(
            "role key must be between 2 and 64 characters",
        ));
    }
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return Err(RestError::validation("role key is required"));
    };
    if !first.is_ascii_lowercase() {
        return Err(RestError::validation(
            "role key must start with a lowercase ascii letter",
        ));
    }
    if !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') {
        return Err(RestError::validation(
            "role key may contain lowercase ascii letters, digits, and underscores only",
        ));
    }
    if Role::ALL
        .into_iter()
        .any(|role| value.eq_ignore_ascii_case(role.as_str()))
    {
        return Err(RestError::validation(
            "custom role key must not shadow a built-in role",
        ));
    }
    Ok(value.to_owned())
}

pub(crate) fn normalize_policy_display_name(raw: &str) -> Result<String, RestError> {
    let value = raw.trim();
    if value.is_empty() || value.chars().count() > 80 {
        return Err(RestError::validation(
            "display name must be between 1 and 80 characters",
        ));
    }
    Ok(value.to_owned())
}

pub(crate) fn normalize_policy_description(raw: Option<&str>) -> Result<Option<String>, RestError> {
    let Some(value) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if value.chars().count() > 512 {
        return Err(RestError::validation(
            "description must be 512 characters or fewer",
        ));
    }
    Ok(Some(value.to_owned()))
}

pub(crate) fn validate_policy_permissions(
    raw: &[PolicyPermissionResponse],
    allow_empty: bool,
) -> Result<Vec<PolicyRolePermission>, RestError> {
    let mut seen = BTreeSet::new();
    let mut permissions = Vec::new();
    for permission in raw {
        let feature = Feature::from_str(&permission.feature_key)
            .map_err(|_| RestError::validation("unknown feature key"))?;
        if !custom_role_runtime_feature_allowed(feature) {
            return Err(RestError::forbidden(
                "custom roles cannot grant elevated or scope-widening policy features yet",
            ));
        }
        let level = PermissionLevel::from_str(&permission.permission_level)
            .map_err(|_| RestError::validation("unknown permission level"))?;
        if !seen.insert(feature) {
            return Err(RestError::validation("duplicate feature permission"));
        }
        if matches!(level, PermissionLevel::Deny) {
            continue;
        }
        permissions.push(PolicyRolePermission {
            feature_key: feature.as_str().to_owned(),
            permission_level: level.as_str().to_owned(),
        });
    }
    if permissions.is_empty() && !allow_empty {
        return Err(RestError::validation(
            "custom role must grant at least one non-deny feature",
        ));
    }
    Ok(permissions)
}

pub(crate) fn validate_policy_conditions(
    raw: &[PolicyConditionResponse],
) -> Result<Vec<PolicyRoleCondition>, RestError> {
    if raw.len() > 20 {
        return Err(RestError::validation(
            "custom role may define at most 20 policy conditions",
        ));
    }

    let mut seen_keys = BTreeSet::new();
    let mut conditions = Vec::with_capacity(raw.len());
    for condition in raw {
        let condition_key = normalize_policy_condition_key(&condition.condition_key)?;
        if !seen_keys.insert(condition_key.clone()) {
            return Err(RestError::validation("duplicate policy condition key"));
        }
        let attribute = normalize_policy_condition_attribute(&condition.attribute)?;
        let operator = normalize_policy_condition_operator(&condition.operator)?;
        let values = normalize_policy_condition_values(&condition.values)?;
        conditions.push(PolicyRoleCondition {
            condition_key,
            attribute,
            operator,
            values,
        });
    }
    Ok(conditions)
}

pub(crate) fn normalize_policy_condition_key(raw: &str) -> Result<String, RestError> {
    let value = raw.trim();
    if value.len() < 2 || value.len() > 64 {
        return Err(RestError::validation(
            "condition key must be between 2 and 64 characters",
        ));
    }
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return Err(RestError::validation("condition key is required"));
    };
    if !first.is_ascii_lowercase()
        || !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    {
        return Err(RestError::validation(
            "condition key may contain lowercase ascii letters, digits, and underscores only",
        ));
    }
    Ok(value.to_owned())
}

pub(crate) fn normalize_policy_condition_attribute(raw: &str) -> Result<String, RestError> {
    let value = raw.trim().to_ascii_lowercase();
    match value.as_str() {
        "group" | "tenant" | "organization" | "org" | "department" | "team" | "position"
        | "employment_status" | "assignment" | "location" | "site" | "branch"
        | "device_posture" | "purpose" | "action" | "resource" | "sensitive_action" => Ok(value),
        _ => Err(RestError::validation("unknown policy condition attribute")),
    }
}

pub(crate) fn normalize_policy_condition_operator(raw: &str) -> Result<String, RestError> {
    let value = raw.trim().to_ascii_lowercase();
    match value.as_str() {
        "equals" | "not_equals" | "in" => Ok(value),
        _ => Err(RestError::validation("unknown policy condition operator")),
    }
}

pub(crate) fn normalize_policy_condition_values(raw: &[String]) -> Result<Vec<String>, RestError> {
    if raw.is_empty() || raw.len() > 20 {
        return Err(RestError::validation(
            "policy condition values must contain 1 to 20 entries",
        ));
    }
    let mut seen = BTreeSet::new();
    let mut values = Vec::with_capacity(raw.len());
    for value in raw {
        let trimmed = value.trim();
        if trimmed.is_empty() || trimmed.chars().count() > 120 {
            return Err(RestError::validation(
                "policy condition values must be non-empty and 120 characters or fewer",
            ));
        }
        if trimmed.chars().any(char::is_control) {
            return Err(RestError::validation(
                "policy condition values must not contain control characters",
            ));
        }
        if !seen.insert(trimmed.to_owned()) {
            return Err(RestError::validation("duplicate policy condition value"));
        }
        values.push(trimmed.to_owned());
    }
    Ok(values)
}
