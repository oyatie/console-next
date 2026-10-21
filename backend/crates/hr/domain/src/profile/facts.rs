//! Person and employment fact rules (parity E3, E4, E12/F5). Pure: `today` is
//! a parameter, and the lead time of the 수습 종료 reminder arrives from the
//! caller's settings lookup.

use console_kernel_core::KernelError;
use time::{Date, Month};

/// The `employees_work_email_shape` bound (RFC 5321 §4.5.3.1.3 path limit).
const WORK_EMAIL_MAX: usize = 254;

/// 업무용 이메일 (E3): trimmed, one `@`, no whitespace, a dotted domain, which
/// is lower-cased (the local part is left as typed: RFC 5321 §2.4).
///
/// # Errors
/// Validation when the address cannot be a deliverable mailbox.
pub fn normalize_work_email(raw: &str) -> Result<String, KernelError> {
    normalize_email(raw, "work_email")
}

/// Any mailbox field (업무용 or 개인 메일) under the rule of
/// [`normalize_work_email`]; `field` names it in the refusal.
///
/// # Errors
/// Validation when the address cannot be a deliverable mailbox.
pub fn normalize_email(raw: &str, field: &str) -> Result<String, KernelError> {
    let value = raw.trim();
    let invalid =
        || KernelError::validation(format!("{field} must be a mailbox like name@example.com"));
    if value.len() > WORK_EMAIL_MAX || value.chars().any(char::is_whitespace) {
        return Err(invalid());
    }
    let (local, domain) = value.split_once('@').ok_or_else(invalid)?;
    let dotted = domain.split('.').all(|label| !label.is_empty()) && domain.contains('.');
    if local.is_empty() || domain.contains('@') || !dotted {
        return Err(invalid());
    }
    Ok(format!("{local}@{}", domain.to_ascii_lowercase()))
}

/// 생년월일 (E4): a real past date, not before 1900 (the column floor). Age
/// rules (연소자, 55세) are read from it elsewhere and never refuse here.
///
/// # Errors
/// Validation when the date is in the future or before 1900-01-01.
pub fn validate_birth_date(birth_date: Date, today: Date) -> Result<(), KernelError> {
    let floor = Date::from_calendar_date(1900, Month::January, 1)
        .map_err(|_| KernelError::internal("birth date floor"))?;
    if birth_date > today || birth_date < floor {
        return Err(KernelError::validation(
            "birth_date must be a past date on or after 1900-01-01",
        ));
    }
    Ok(())
}

/// 수습 종료일 (E12): the period starts on the hire date, so it must end on or
/// after it. A confirmed probation is closed and cannot be re-dated.
///
/// # Errors
/// Validation for an end before the hire date; invalid transition once the
/// 수습 종료 is confirmed.
pub fn validate_probation_end(
    end_date: Date,
    hire_date: Option<Date>,
    confirmed: bool,
) -> Result<(), KernelError> {
    if confirmed {
        return Err(KernelError::invalid_transition(
            "probation is already confirmed as ended; it cannot be re-dated",
        ));
    }
    if hire_date.is_some_and(|hire| end_date < hire) {
        return Err(KernelError::validation(
            "probation_end_date must be on or after the hire date",
        ));
    }
    Ok(())
}

/// Where a probation stands on `today` (F5: the 「수습 종료 D-n」 queue item).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ProbationState {
    /// No probation recorded.
    None,
    /// Ends later than the reminder window.
    Running,
    /// Inside the reminder window: HR owes the 수습 종료 decision.
    DueSoon,
    /// The end date passed without a recorded 수습 종료.
    Overdue,
    Confirmed,
}

/// The probation clock: state plus signed days until the end date (negative
/// once overdue). `lead_days` is the settings value for the reminder window;
/// `None` (no value configured) never classifies DUE_SOON.
#[must_use]
pub fn probation_state(
    end_date: Option<Date>,
    confirmed: bool,
    today: Date,
    lead_days: Option<u16>,
) -> (ProbationState, Option<i64>) {
    let Some(end) = end_date else {
        return (ProbationState::None, None);
    };
    let days_left = (end - today).whole_days();
    let state = if confirmed {
        ProbationState::Confirmed
    } else if days_left < 0 {
        ProbationState::Overdue
    } else if lead_days.is_some_and(|lead| days_left <= i64::from(lead)) {
        ProbationState::DueSoon
    } else {
        ProbationState::Running
    };
    (state, Some(days_left))
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;

    #[test]
    fn work_email_is_trimmed_and_domain_lowercased() {
        assert_eq!(
            normalize_work_email("  Kim.Lee@Corp.EXAMPLE.COM ").unwrap(),
            "Kim.Lee@corp.example.com"
        );
        for bad in [
            "",
            "kim",
            "kim@",
            "@corp.example",
            "kim@corp",
            "kim@@corp.example",
            "k im@corp.example",
            "kim@corp..kr",
        ] {
            assert!(normalize_work_email(bad).is_err(), "{bad}");
        }
        assert!(normalize_work_email(&format!("{}@corp.example", "a".repeat(250))).is_err());
    }

    #[test]
    fn birth_date_bounds() {
        let today = date!(2026 - 10 - 03);
        assert!(validate_birth_date(date!(1994 - 03 - 02), today).is_ok());
        assert!(validate_birth_date(today, today).is_ok());
        assert!(validate_birth_date(date!(2026 - 10 - 04), today).is_err());
        assert!(validate_birth_date(date!(1899 - 12 - 31), today).is_err());
    }

    #[test]
    fn probation_end_needs_hire_order_and_an_open_probation() {
        let hire = Some(date!(2026 - 09 - 01));
        assert!(validate_probation_end(date!(2026 - 11 - 30), hire, false).is_ok());
        assert!(validate_probation_end(date!(2026 - 08 - 31), hire, false).is_err());
        assert!(validate_probation_end(date!(2026 - 11 - 30), None, false).is_ok());
        assert!(validate_probation_end(date!(2026 - 11 - 30), hire, true).is_err());
    }

    #[test]
    fn probation_clock_states() {
        let end = Some(date!(2026 - 10 - 17));
        let at = |today| probation_state(end, false, today, Some(14));
        assert_eq!(
            at(date!(2026 - 10 - 02)),
            (ProbationState::Running, Some(15))
        );
        assert_eq!(
            at(date!(2026 - 10 - 03)),
            (ProbationState::DueSoon, Some(14))
        );
        assert_eq!(
            at(date!(2026 - 10 - 17)),
            (ProbationState::DueSoon, Some(0))
        );
        assert_eq!(
            at(date!(2026 - 10 - 18)),
            (ProbationState::Overdue, Some(-1))
        );
        assert_eq!(
            probation_state(end, true, date!(2026 - 10 - 18), Some(14)).0,
            ProbationState::Confirmed
        );
        assert_eq!(
            probation_state(None, false, date!(2026 - 10 - 18), Some(14)),
            (ProbationState::None, None)
        );
        assert_eq!(
            probation_state(end, false, date!(2026 - 10 - 17), None).0,
            ProbationState::Running
        );
    }
}
