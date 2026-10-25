// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[tokio::test]
async fn exit_guard_hook_codes_survive_the_adapter_boundary() {
    use console_hr_adapter_postgres::lifecycle::title_reason::coded;
    for (code, message, status) in [
        (
            "dismissal_notice_short",
            "dismissal notice requires pay in lieu or an evidenced statutory ground",
            409,
        ),
        (
            "employee_exited_read_only",
            "a former employee's record can only be changed through a governed correction",
            409,
        ),
        (
            "fixed_term_basis_unconfirmed",
            "fixed-term contract history requires confirmation",
            409,
        ),
        (
            "rehire_exit_case_open",
            "the prior exit decision or its remaining settlement must be resolved or acknowledged",
            409,
        ),
        (
            "exit_protected_period",
            "dismissal is blocked during a protected leave period",
            409,
        ),
        (
            "notice_evidence_missing",
            "written dismissal notice evidence is required",
            422,
        ),
        (
            "exit_reason_required",
            "an exit reason is required for HR confirmation",
            422,
        ),
        (
            "exit_case_required",
            "an exit case is required for termination",
            409,
        ),
    ] {
        let error = if status == 409 {
            KernelError::conflict(message)
        } else {
            KernelError::validation(message)
        };
        pin(coded(error.with_code(code)), status, code, message).await;
        assert_ne!(
            console_platform_request_context::error_i18n::korean_message(code, message),
            message
        );
    }
}
