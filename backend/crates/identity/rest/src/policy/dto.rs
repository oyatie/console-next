use console_kernel_core::BranchId;
use console_platform_auth::PasskeyAuthenticationCredential;
use serde::Deserialize;
use serde::Serialize;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, Serialize)]
pub(crate) struct PolicyFeatureResponse {
    pub(crate) feature_key: String,
    pub(crate) elevated: bool,
    pub(crate) default_permissions: Vec<PolicyDefaultPermissionResponse>,
}

#[derive(Debug, Serialize)]
pub(crate) struct PolicyDefaultPermissionResponse {
    pub(crate) role_key: String,
    pub(crate) permission_level: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct PolicyRoleCatalogResponse {
    pub(crate) policy_version: PolicyVersionResponse,
    pub(crate) system_roles: Vec<SystemPolicyRoleResponse>,
    pub(crate) custom_roles: Vec<PolicyRoleResponse>,
}

#[derive(Debug, Serialize)]
pub(crate) struct PolicyVersionResponse {
    pub(crate) version: i64,
    #[serde(with = "time::serde::rfc3339::option")]
    pub(crate) updated_at: Option<OffsetDateTime>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct PolicyAuditEventsQuery {
    pub(crate) limit: Option<i64>,
}

#[derive(Debug, Serialize)]
pub(crate) struct PolicyAuditEventResponse {
    pub(crate) id: Uuid,
    pub(crate) actor: Option<Uuid>,
    pub(crate) action: String,
    pub(crate) target_type: String,
    pub(crate) target_id: String,
    pub(crate) before_snapshot: Option<serde_json::Value>,
    pub(crate) after_snapshot: Option<serde_json::Value>,
    pub(crate) trace_id: String,
    pub(crate) span_id: String,
    #[serde(with = "time::serde::rfc3339")]
    pub(crate) occurred_at: OffsetDateTime,
}

#[derive(Debug, Serialize)]
pub(crate) struct SystemPolicyRoleResponse {
    pub(crate) role_key: String,
    pub(crate) display_name: String,
    pub(crate) status: String,
    pub(crate) is_system: bool,
    pub(crate) permissions: Vec<PolicyPermissionResponse>,
}

#[derive(Debug, Serialize)]
pub(crate) struct PolicyRoleResponse {
    pub(crate) id: Uuid,
    pub(crate) role_key: String,
    pub(crate) display_name: String,
    pub(crate) description: Option<String>,
    pub(crate) status: String,
    pub(crate) is_system: bool,
    pub(crate) permissions: Vec<PolicyPermissionResponse>,
    pub(crate) conditions: Vec<PolicyConditionResponse>,
    #[serde(with = "time::serde::rfc3339")]
    pub(crate) created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub(crate) updated_at: OffsetDateTime,
}

#[derive(Debug, Serialize)]
pub(crate) struct PolicyRoleStatusPreviewResponse {
    pub(crate) role_id: Uuid,
    pub(crate) role_key: String,
    pub(crate) display_name: String,
    pub(crate) current_status: String,
    pub(crate) requested_status: String,
    pub(crate) permission_count: i64,
    pub(crate) condition_count: i64,
    pub(crate) planned_assignment_count: i64,
    pub(crate) requires_passkey_step_up: bool,
    pub(crate) effective_runtime_change: bool,
    pub(crate) warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct PolicyPermissionResponse {
    pub(crate) feature_key: String,
    pub(crate) permission_level: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct PolicyConditionResponse {
    pub(crate) condition_key: String,
    pub(crate) attribute: String,
    pub(crate) operator: String,
    pub(crate) values: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CreatePolicyRoleRequest {
    pub(crate) role_key: String,
    pub(crate) display_name: String,
    #[serde(default)]
    pub(crate) description: Option<String>,
    #[serde(default)]
    pub(crate) permissions: Vec<PolicyPermissionResponse>,
    #[serde(default)]
    pub(crate) conditions: Vec<PolicyConditionResponse>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct UpdatePolicyRoleRequest {
    pub(crate) display_name: String,
    #[serde(default)]
    pub(crate) description: Option<String>,
    #[serde(default)]
    pub(crate) permissions: Vec<PolicyPermissionResponse>,
    #[serde(default)]
    pub(crate) conditions: Vec<PolicyConditionResponse>,
    #[serde(default)]
    pub(crate) step_up: Option<PolicyStepUpAssertionRequest>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct PolicyStepUpAssertionRequest {
    pub(crate) ceremony_id: Uuid,
    pub(crate) credential: PasskeyAuthenticationCredential,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct UpdatePolicyRoleStatusRequest {
    #[serde(deserialize_with = "deserialize_enum_27")]
    pub(crate) status: String,
    #[serde(default)]
    pub(crate) step_up: Option<PolicyStepUpAssertionRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PolicyRoleStatusPreviewRequest {
    #[serde(deserialize_with = "deserialize_enum_26")]
    pub(crate) status: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct PolicyRoleTemplateResponse {
    pub(crate) template_key: String,
    pub(crate) role_key: String,
    pub(crate) display_name: String,
    pub(crate) category: String,
    pub(crate) description: String,
    pub(crate) permissions: Vec<PolicyPermissionResponse>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ListPolicyAssignmentsRequest {
    pub(crate) user_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
pub(crate) struct PolicyRoleAssignmentResponse {
    pub(crate) user_id: Uuid,
    pub(crate) role_id: Uuid,
    pub(crate) role_key: String,
    pub(crate) display_name: String,
    pub(crate) status: String,
    pub(crate) assigned_by: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339")]
    pub(crate) created_at: OffsetDateTime,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReplacePolicyRoleAssignmentsRequest {
    /// Custom-role replacement set. For account/person role-or-scope previews,
    /// omitting this field preserves the target's current custom-role set;
    /// sending an explicit empty array previews replacing it with no custom roles.
    #[serde(default)]
    pub(crate) role_ids: Option<Vec<Uuid>>,
    /// Optional replacement system-role set used by account/person mutation
    /// previews. The custom-role save endpoint ignores this and preserves the
    /// target's current system roles.
    #[serde(default)]
    pub(crate) system_roles: Option<Vec<String>>,
    /// Optional replacement branch-scope set used by account/person mutation
    /// previews. The custom-role save endpoint ignores this and preserves the
    /// target's current branch memberships.
    #[serde(default)]
    pub(crate) branch_ids: Option<Vec<BranchId>>,
    #[serde(default)]
    pub(crate) preview_acknowledged: bool,
    #[serde(default)]
    pub(crate) preview_receipt_id: Option<Uuid>,
    #[serde(default)]
    pub(crate) step_up: Option<PolicyStepUpAssertionRequest>,
}

#[derive(Debug, Serialize)]
pub(crate) struct PolicyRoleAssignmentDeltaResponse {
    pub(crate) added_role_ids: Vec<Uuid>,
    pub(crate) removed_role_ids: Vec<Uuid>,
    pub(crate) unchanged_role_ids: Vec<Uuid>,
}

#[derive(Debug, Serialize)]
pub(crate) struct PolicyRoleImpactResponse {
    pub(crate) role_id: Uuid,
    pub(crate) role_key: String,
    pub(crate) display_name: String,
    pub(crate) status: String,
    pub(crate) runtime_effective: bool,
    pub(crate) runtime_warnings: Vec<String>,
    pub(crate) conditions: Vec<PolicyConditionResponse>,
}

#[derive(Debug, Serialize)]
pub(crate) struct PolicyFeatureGrantPreviewResponse {
    pub(crate) feature_key: String,
    pub(crate) permission_level: String,
    pub(crate) source_type: String,
    pub(crate) source_key: String,
    pub(crate) source_label: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct PolicyAssignmentPreviewResponse {
    pub(crate) user_id: Uuid,
    pub(crate) preview_receipt_id: Uuid,
    #[serde(with = "time::serde::rfc3339")]
    pub(crate) preview_receipt_expires_at: OffsetDateTime,
    pub(crate) effective: bool,
    pub(crate) system_roles: Vec<String>,
    pub(crate) current_system_roles: Vec<String>,
    pub(crate) requested_system_roles: Vec<String>,
    pub(crate) current_branch_ids: Vec<Uuid>,
    pub(crate) requested_branch_ids: Vec<Uuid>,
    pub(crate) current_role_ids: Vec<Uuid>,
    pub(crate) requested_role_ids: Vec<Uuid>,
    pub(crate) delta: PolicyRoleAssignmentDeltaResponse,
    pub(crate) custom_roles: Vec<PolicyRoleImpactResponse>,
    pub(crate) feature_grants: Vec<PolicyFeatureGrantPreviewResponse>,
    pub(crate) warnings: Vec<String>,
}

#[cfg(test)]
#[path = "dto_unknown_fields.rs"]
mod unknown_fields_tests;

fn deserialize_enum_26<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(
        deserializer,
        &["DRAFT", "ACTIVE", "RETIRED"],
    )
}

fn deserialize_enum_27<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(
        deserializer,
        &["DRAFT", "ACTIVE", "RETIRED"],
    )
}
