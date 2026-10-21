use crate::policy::dto::PolicyStepUpAssertionRequest;
use crate::serde_util::deserialize_optional_field;
use console_identity_domain::Team;
use console_kernel_core::BranchId;
use serde::Deserialize;
use serde::Serialize;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Request / response DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CreateUserRequest {
    pub(crate) display_name: String,
    #[serde(default)]
    pub(crate) employee_id: Option<uuid::Uuid>,
    #[serde(default)]
    pub(crate) phone: Option<String>,
    #[serde(default)]
    pub(crate) team: Option<Team>,
    #[serde(default)]
    pub(crate) roles: Vec<String>,
    #[serde(default)]
    pub(crate) branch_ids: Vec<BranchId>,
    /// The 아이디 HR sets at invite (decisions #33); absent or empty takes the
    /// default (사번, else `u` + the UUID's random tail).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) sign_in_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct UpdateUserRequest {
    #[serde(default)]
    pub(crate) display_name: Option<String>,
    /// Present key (even `null`) updates the employee link; absent leaves it unchanged.
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub(crate) employee_id: Option<Option<uuid::Uuid>>,
    /// Present key (even `null`) updates the phone; absent leaves it unchanged.
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub(crate) phone: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub(crate) team: Option<Option<Team>>,
    #[serde(default)]
    pub(crate) roles: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) branch_ids: Option<Vec<BranchId>>,
    /// Required when `roles` or `branch_ids` is present.
    #[serde(default)]
    pub(crate) preview_acknowledged: bool,
    /// Server-issued impact-preview receipt for the exact role/scope edit.
    #[serde(default)]
    pub(crate) preview_receipt_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct UpdateSelfRequest {
    #[serde(default)]
    pub(crate) display_name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub(crate) phone: Option<Option<String>>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ListUsersRequest {
    #[serde(default)]
    pub(crate) include_inactive: bool,
    pub(crate) limit: Option<i64>,
    /// Zero-based row offset for offset pagination. Optional, defaults to 0.
    pub(crate) offset: Option<i64>,
}

/// Body of `POST /api/v1/users/{id}/deactivate`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DeactivateUserRequest {
    pub(crate) step_up: Option<PolicyStepUpAssertionRequest>,
}

#[cfg(test)]
#[path = "dto_unknown_fields.rs"]
mod unknown_fields_tests;
