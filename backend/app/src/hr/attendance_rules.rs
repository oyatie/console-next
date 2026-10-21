//! Employee attendance input rules, moved verbatim from `hr.rs` (file-size
//! ratchet): the record kind, the note bound and the state machine.

use console_hr_adapter_postgres::HrError;
use console_kernel_core::KernelError;

use console_hr_domain::text::normalize_optional_text;

pub(super) fn normalize_attendance_kind(raw: &str) -> Result<&'static str, HrError> {
    match raw.trim().to_ascii_uppercase().as_str() {
        "CLOCK_IN" => Ok("CLOCK_IN"),
        "OUT_FOR_WORK" => Ok("OUT_FOR_WORK"),
        "BUSINESS_TRIP" => Ok("BUSINESS_TRIP"),
        "RETURNED" => Ok("RETURNED"),
        "CLOCK_OUT" => Ok("CLOCK_OUT"),
        _ => Err(HrError::validation("unsupported attendance record kind")),
    }
}

pub(super) fn normalize_attendance_note(value: Option<String>) -> Result<Option<String>, HrError> {
    match normalize_optional_text(value) {
        Some(value) if value.chars().count() > 500 => Err(HrError::validation(
            "attendance note must be 500 characters or fewer",
        )),
        value => Ok(value),
    }
}

pub(super) fn next_employee_attendance_state(
    previous_state: Option<&str>,
    kind: &str,
) -> Result<&'static str, HrError> {
    match (previous_state.unwrap_or("OFF_DUTY"), kind) {
        ("OFF_DUTY", "CLOCK_IN") => Ok("CLOCKED_IN"),
        ("CLOCKED_IN", "OUT_FOR_WORK") => Ok("OUT_FOR_WORK"),
        ("CLOCKED_IN", "BUSINESS_TRIP") => Ok("BUSINESS_TRIP"),
        ("CLOCKED_IN", "CLOCK_OUT") => Ok("OFF_DUTY"),
        ("OUT_FOR_WORK", "RETURNED") | ("BUSINESS_TRIP", "RETURNED") => Ok("CLOCKED_IN"),
        ("OUT_FOR_WORK", "CLOCK_OUT") | ("BUSINESS_TRIP", "CLOCK_OUT") => Ok("OFF_DUTY"),
        (_, _) => Err(HrError::from_kernel(KernelError::invalid_transition(
            "invalid employee attendance transition",
        ))),
    }
}
