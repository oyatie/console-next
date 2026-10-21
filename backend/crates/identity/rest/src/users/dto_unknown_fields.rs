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
