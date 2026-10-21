#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_platform_test_support::strict_json;

#[test]
fn unknown_fields_create_employee_lifecycle_event_request() {
    strict_json::rejects_unknown_with::<super::CreateEmployeeLifecycleEventRequest>(
        serde_json::json!({
            "event_type": "APPOINT", "effective_date": "2026-10-10", "comment": "known fields",
            "expected_head_version": 4, "to_job": "Engineer", "vacate_position_kind": true,
            "to_employment_type": "REGULAR", "expected_contract_end_date": "2026-12-31"
        }),
    );
}
