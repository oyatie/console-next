#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_platform_test_support::strict_json;

#[test]
fn unknown_fields_transition_lifecycle_request() {
    strict_json::rejects_unknown::<super::TransitionLifecycleRequest>();
}

#[test]
fn unknown_fields_set_lifecycle_hold_request() {
    strict_json::rejects_unknown::<super::SetLifecycleHoldRequest>();
}
