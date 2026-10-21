//! BW-13 leave facts: a LEAVE_OF_ABSENCE names its type, and the statutory
//! leaves with a fixed span name their return date.

use console_kernel_core::KernelError;

/// Built-in leave types (0245 CHECK list).
pub const LEAVE_TYPES: [&str; 5] = ["CHILDCARE", "MATERNITY", "ILLNESS", "PERSONAL", "OTHER"];

/// 육아휴직 (남녀고용평등법 §19) and 출산전후휴가 (근로기준법 §74) end on a
/// known date, so the return date is required.
pub const RETURN_DATE_REQUIRED: [&str; 2] = ["CHILDCARE", "MATERNITY"];

/// Checks a LEAVE_OF_ABSENCE's type and return date (both already normalised).
///
/// # Errors
/// 422 `leave_type_required`, `leave_type_invalid` or `leave_return_date_required`.
pub fn check_leave_facts(
    leave_type: Option<&str>,
    expected_return_date: Option<&str>,
) -> Result<(), KernelError> {
    let Some(leave_type) = leave_type else {
        return Err(
            KernelError::validation("leave_type is required for LEAVE_OF_ABSENCE")
                .with_code("leave_type_required")
                .with_field("leave_type"),
        );
    };
    if !LEAVE_TYPES.contains(&leave_type) {
        return Err(KernelError::validation(
            "leave_type must be CHILDCARE, MATERNITY, ILLNESS, PERSONAL, or OTHER",
        )
        .with_code("leave_type_invalid")
        .with_field("leave_type"));
    }
    if RETURN_DATE_REQUIRED.contains(&leave_type) && expected_return_date.is_none() {
        return Err(KernelError::validation(format!(
            "expected_return_date is required for {leave_type} leave"
        ))
        .with_code("leave_return_date_required")
        .with_field("expected_return_date"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leave_needs_a_type() {
        let err = check_leave_facts(None, Some("2027-01-31")).unwrap_err();
        assert_eq!(err.code, Some("leave_type_required"));
        assert_eq!(
            check_leave_facts(Some("VACATION"), None).unwrap_err().code,
            Some("leave_type_invalid")
        );
    }

    #[test]
    fn childcare_and_maternity_need_a_return_date() {
        for kind in RETURN_DATE_REQUIRED {
            assert_eq!(
                check_leave_facts(Some(kind), None).unwrap_err().code,
                Some("leave_return_date_required")
            );
            assert!(check_leave_facts(Some(kind), Some("2027-01-31")).is_ok());
        }
        assert!(check_leave_facts(Some("ILLNESS"), None).is_ok());
    }
}
