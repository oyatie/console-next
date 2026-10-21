//! BW-13 job-title rules: the catalog label and the 강등 check on PROMOTE.

use console_kernel_core::KernelError;

/// The `lifecycle_promote` reason code a move to a lower grade needs.
pub const DEMOTION_REASON_CODE: &str = "DISCIPLINARY_DEMOTION";

/// Longest catalog label (matches `job_titles_label_shape`).
pub const LABEL_MAX_CHARS: usize = 100;

/// A catalog label as stored: trimmed, 1..=100 characters.
///
/// # Errors
/// 422 `job_title_label_invalid`.
pub fn normalize_job_title_label(raw: &str) -> Result<String, KernelError> {
    let label = raw.trim();
    if label.is_empty() || label.chars().count() > LABEL_MAX_CHARS {
        return Err(KernelError::validation(format!(
            "label must be 1 to {LABEL_MAX_CHARS} characters"
        ))
        .with_code("job_title_label_invalid")
        .with_field("label"));
    }
    Ok(label.to_owned())
}

/// A PROMOTE to a lower `grade_rank` (higher = more senior) needs the
/// [`DEMOTION_REASON_CODE`]. An unranked side (or no catalog title on either
/// side) gives no verdict, so it is allowed.
///
/// # Errors
/// 422 `demotion_reason_required`.
pub fn check_demotion_reason(
    from_rank: Option<i32>,
    to_rank: Option<i32>,
    reason_code: Option<&str>,
) -> Result<(), KernelError> {
    match (from_rank, to_rank) {
        (Some(from), Some(to)) if to < from && reason_code != Some(DEMOTION_REASON_CODE) => {
            Err(KernelError::validation(
                "a move to a lower grade needs reason code DISCIPLINARY_DEMOTION (강등(징계))",
            )
            .with_code("demotion_reason_required")
            .with_field("reason_code"))
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_is_trimmed_and_bounded() {
        assert_eq!(normalize_job_title_label("  과장 ").unwrap(), "과장");
        assert_eq!(
            normalize_job_title_label("   ").unwrap_err().code,
            Some("job_title_label_invalid")
        );
        assert!(normalize_job_title_label(&"가".repeat(101)).is_err());
        assert!(normalize_job_title_label(&"가".repeat(100)).is_ok());
    }

    #[test]
    fn lower_rank_needs_the_demotion_code() {
        let refused = check_demotion_reason(Some(5), Some(3), None).unwrap_err();
        assert_eq!(refused.code, Some("demotion_reason_required"));
        assert!(check_demotion_reason(Some(5), Some(3), Some("REGULAR_PROMOTION")).is_err());
        assert!(check_demotion_reason(Some(5), Some(3), Some(DEMOTION_REASON_CODE)).is_ok());
    }

    #[test]
    fn same_or_higher_or_unranked_is_no_demotion() {
        assert!(check_demotion_reason(Some(3), Some(5), None).is_ok());
        assert!(check_demotion_reason(Some(3), Some(3), None).is_ok());
        assert!(check_demotion_reason(None, Some(1), None).is_ok());
        assert!(check_demotion_reason(Some(5), None, None).is_ok());
    }
}
