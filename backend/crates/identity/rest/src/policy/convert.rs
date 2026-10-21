use crate::policy::dto::PolicyAuditEventResponse;
use crate::policy::dto::PolicyConditionResponse;
use crate::policy::dto::PolicyPermissionResponse;
use crate::policy::dto::PolicyRoleAssignmentResponse;
use crate::policy::dto::PolicyRoleResponse;
use crate::policy::dto::PolicyRoleStatusPreviewResponse;
use crate::policy::dto::PolicyVersionResponse;
use crate::policy::runtime::policy_feature_key_visible;
use crate::policy::runtime::runtime_allowed_policy_permissions;
use console_identity_application::PolicyAuditEventSummary;
use console_identity_application::PolicyRoleAssignmentSummary;
use console_identity_application::PolicyRoleCondition;
use console_identity_application::PolicyRoleSummary;
use console_identity_application::PolicyVersionSummary;

impl From<PolicyVersionSummary> for PolicyVersionResponse {
    fn from(value: PolicyVersionSummary) -> Self {
        Self {
            version: value.version,
            updated_at: value.updated_at,
        }
    }
}

impl From<PolicyAuditEventSummary> for PolicyAuditEventResponse {
    fn from(value: PolicyAuditEventSummary) -> Self {
        Self {
            id: value.id,
            actor: value.actor.map(|user_id| *user_id.as_uuid()),
            action: value.action,
            target_type: value.target_type,
            target_id: value.target_id,
            before_snapshot: value.before_snapshot,
            after_snapshot: value.after_snapshot,
            trace_id: value.trace_id,
            span_id: value.span_id,
            occurred_at: value.occurred_at,
        }
    }
}

pub(crate) fn build_policy_role_status_preview(
    role: &PolicyRoleSummary,
    requested_status: String,
    planned_assignment_count: i64,
) -> PolicyRoleStatusPreviewResponse {
    let runtime_permission_count = runtime_allowed_policy_permissions(role).len();
    let effective_runtime_change = runtime_permission_count > 0
        && planned_assignment_count > 0
        && role.status != requested_status
        && (role.status == "ACTIVE" || requested_status == "ACTIVE");
    let mut warnings = vec!["passkey_step_up_required".to_owned()];
    if role.status == requested_status {
        warnings.push("no_status_change".to_owned());
    }
    if planned_assignment_count > 0 && runtime_permission_count > 0 {
        warnings.push("assigned_users_may_gain_or_lose_runtime_permissions".to_owned());
    }
    if requested_status == "DRAFT" && role.status == "ACTIVE" && effective_runtime_change {
        warnings.push("rollback_disables_assigned_custom_role_runtime_grants".to_owned());
    }
    if requested_status == "RETIRED" && role.status == "ACTIVE" && effective_runtime_change {
        warnings.push("retire_disables_assigned_custom_role_runtime_grants".to_owned());
    }
    if requested_status == "ACTIVE" && role.status != requested_status && effective_runtime_change {
        warnings.push("publish_enables_assigned_custom_role_runtime_grants".to_owned());
    }

    PolicyRoleStatusPreviewResponse {
        role_id: role.id,
        role_key: role.role_key.clone(),
        display_name: role.display_name.clone(),
        current_status: role.status.clone(),
        requested_status,
        permission_count: runtime_permission_count as i64,
        condition_count: role.conditions.len() as i64,
        planned_assignment_count,
        requires_passkey_step_up: true,
        effective_runtime_change,
        warnings,
    }
}

impl From<PolicyRoleSummary> for PolicyRoleResponse {
    fn from(value: PolicyRoleSummary) -> Self {
        Self {
            id: value.id,
            role_key: value.role_key,
            display_name: value.display_name,
            description: value.description,
            status: value.status,
            is_system: value.is_system,
            permissions: value
                .permissions
                .into_iter()
                .filter(|permission| policy_feature_key_visible(&permission.feature_key))
                .map(|permission| PolicyPermissionResponse {
                    feature_key: permission.feature_key,
                    permission_level: permission.permission_level,
                })
                .collect(),
            conditions: value
                .conditions
                .into_iter()
                .map(policy_condition_response)
                .collect(),
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
    }
}

pub(crate) fn policy_condition_response(condition: PolicyRoleCondition) -> PolicyConditionResponse {
    PolicyConditionResponse {
        condition_key: condition.condition_key,
        attribute: condition.attribute,
        operator: condition.operator,
        values: condition.values,
    }
}

impl From<PolicyRoleAssignmentSummary> for PolicyRoleAssignmentResponse {
    fn from(value: PolicyRoleAssignmentSummary) -> Self {
        Self {
            user_id: *value.user_id.as_uuid(),
            role_id: value.role_id,
            role_key: value.role_key,
            display_name: value.display_name,
            status: value.status,
            assigned_by: value.assigned_by.map(|user_id| *user_id.as_uuid()),
            created_at: value.created_at,
        }
    }
}
