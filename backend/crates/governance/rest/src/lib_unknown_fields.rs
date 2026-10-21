#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_platform_test_support::strict_json;

#[test]
fn unknown_fields_decide_approval_request() {
    strict_json::rejects_unknown::<super::DecideApprovalRequest>();
}

#[test]
fn unknown_fields_configure_transition_request() {
    strict_json::rejects_unknown::<super::ConfigureTransitionRequest>();
}

#[test]
fn unknown_fields_preflight_request() {
    strict_json::rejects_unknown::<super::PreflightRequest>();
}

#[test]
fn approval_decision_accepts_only_terminal_wire_states() {
    use super::request_bodies::ApprovalDecisionRequest;
    for state in ["approved", "rejected"] {
        assert!(serde_json::from_value::<ApprovalDecisionRequest>(state.into()).is_ok());
    }
    assert!(serde_json::from_value::<ApprovalDecisionRequest>("pending".into()).is_err());
}
