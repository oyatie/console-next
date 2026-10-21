#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_platform_test_support::strict_json;

#[test]
fn unknown_fields_create_policy_role_request() {
    strict_json::rejects_unknown::<super::CreatePolicyRoleRequest>();
}

#[test]
fn unknown_fields_update_policy_role_request() {
    strict_json::rejects_unknown::<super::UpdatePolicyRoleRequest>();
}

#[test]
fn unknown_fields_update_policy_role_status_request() {
    strict_json::rejects_unknown::<super::UpdatePolicyRoleStatusRequest>();
}

#[test]
fn unknown_fields_policy_role_status_preview_request() {
    strict_json::rejects_unknown::<super::PolicyRoleStatusPreviewRequest>();
}

#[test]
fn unknown_fields_replace_policy_role_assignments_request() {
    strict_json::rejects_unknown::<super::ReplacePolicyRoleAssignmentsRequest>();
}
