#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_platform_test_support::strict_json;

#[test]
fn unknown_fields_object_type_lifecycle_request() {
    strict_json::rejects_unknown::<super::ObjectTypeLifecycleRequest>();
}

#[test]
fn unknown_fields_attach_object_policy_request() {
    strict_json::rejects_unknown::<super::AttachObjectPolicyRequest>();
}

#[test]
fn unknown_fields_lifecycle_request() {
    strict_json::rejects_unknown::<super::LifecycleRequest>();
}
