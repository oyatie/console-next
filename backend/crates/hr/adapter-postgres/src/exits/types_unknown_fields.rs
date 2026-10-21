#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_platform_test_support::strict_json;

#[test]
fn unknown_fields_report_employee_exit_case_request() {
    strict_json::rejects_unknown::<super::ReportEmployeeExitCaseRequest>();
}

#[test]
fn unknown_fields_confirm_employee_exit_case_request() {
    strict_json::rejects_unknown::<super::ConfirmEmployeeExitCaseRequest>();
}

#[test]
fn unknown_fields_draft_employee_exit_approval_request() {
    strict_json::rejects_unknown::<super::DraftEmployeeExitApprovalRequest>();
}
