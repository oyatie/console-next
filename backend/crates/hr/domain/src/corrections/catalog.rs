//! Typed catalog assignments may be corrected without creating a personnel action.

use console_kernel_core::KernelError;

#[must_use]
pub fn kind_for_field(field: &str) -> Option<&'static str> {
    match field {
        "grade_id" => Some("GRADE"),
        "job_title_id" => Some("TITLE"),
        "position_kind_id" => Some("POSITION"),
        "job_id" => Some("JOB"),
        "job_family_id" => Some("JOB_FAMILY"),
        _ => None,
    }
}

pub fn validate_entry(field: &str, kind: &str, active: bool) -> Result<(), KernelError> {
    if active && kind_for_field(field) == Some(kind) {
        return Ok(());
    }
    Err(KernelError::validation(format!(
        "{field} is not an active catalog entry of its kind"
    ))
    .with_code("job_title_unknown")
    .with_field(field))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corrections_require_the_matching_active_catalog() {
        for (field, kind) in [
            ("grade_id", "GRADE"),
            ("job_title_id", "TITLE"),
            ("position_kind_id", "POSITION"),
            ("job_id", "JOB"),
            ("job_family_id", "JOB_FAMILY"),
        ] {
            assert!(validate_entry(field, kind, true).is_ok());
            for (wrong, active) in [(kind, false), ("OTHER", true)] {
                let error = validate_entry(field, wrong, active).expect_err("refused");
                assert_eq!(error.code, Some("job_title_unknown"));
            }
        }
        assert_eq!(kind_for_field("position_id"), None);
    }
}
