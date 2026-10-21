#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_platform_test_support::strict_json;

#[test]
fn unknown_fields_create_user_request() {
    strict_json::rejects_unknown::<super::CreateUserRequest>();
}

#[test]
fn unknown_fields_update_user_request() {
    strict_json::rejects_unknown::<super::UpdateUserRequest>();
}

#[test]
fn unknown_fields_update_self_request() {
    strict_json::rejects_unknown::<super::UpdateSelfRequest>();
}

#[test]
fn account_link_accepts_step_up_and_approval_request_id() {
    let body = serde_json::json!({
        "employee_id": null,
        "step_up": null,
        "account_link_request_id": uuid::Uuid::new_v4(),
    });
    serde_json::from_value::<super::UpdateUserRequest>(body)
        .expect("link commands carry passkey and stored request references");
}
