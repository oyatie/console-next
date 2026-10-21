//! MR-26: 등록 취소 (void) of a record that should never have existed, and
//! the 근로자 명부 retention floor that bounds a SETUP delete.
//!
//! Pure: today, the tenant's window and period, and the work-record fact
//! arrive as parameters. The adapter maps each refusal to its wire code.
//!
//! - After 운영 시작 a void is allowed only for a person who never started
//!   (PRE_HIRE), or for one registered under `people.void_window` days ago
//!   whose actor attests 「근무한 적 없음」 (onboarding design §7.3). Anyone
//!   with a work record is exited (퇴직), never voided.
//! - The 근로자 명부 is kept 3 years from the 해고·퇴직·사망일 (근로기준법
//!   §42; 시행령 §22①1, ②1). The period is the tenant's
//!   `retention.labor.employee_register` (never below 3 years, decisions #10);
//!   a year period ends on the same calendar day, or the month's last day
//!   when that day does not exist (민법 §160②③).

use console_kernel_core::KernelError;
use time::{Date, Month};

pub const EMPLOYEE_ALREADY_VOIDED: &str = "employee_already_voided";
pub const EMPLOYEE_VOID_HAS_WORK_RECORDS: &str = "employee_void_has_work_records";
pub const EMPLOYEE_VOID_ATTESTATION_REQUIRED: &str = "employee_void_attestation_required";
pub const EMPLOYEE_VOID_NOT_ELIGIBLE: &str = "employee_void_not_eligible";
pub const EXITED_REGISTER_CONFIRMATION_REQUIRED: &str = "exited_register_confirmation_required";

/// Why a void is allowed; stored on the audit row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoidBasis {
    /// PRE_HIRE: the person never started.
    NeverStarted,
    /// Registered inside the window, the actor attests nobody worked.
    AttestedWithinWindow,
}

impl VoidBasis {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NeverStarted => "NEVER_STARTED",
            Self::AttestedWithinWindow => "ATTESTED_WITHIN_WINDOW",
        }
    }
}

const WORKED: &str = "근무 기록이 있는 직원은 퇴직으로 처리합니다. 중복이면 병합하십시오";

/// The facts a void decision reads, all from the locked record.
#[derive(Debug, Clone, Copy)]
pub struct VoidFacts<'a> {
    pub employment_status: &'a str,
    /// KST date the record was registered (created).
    pub registered_on: Date,
    /// An exit case, an applied lifecycle act other than ONBOARD, an
    /// attendance record or a payroll line names the person.
    pub has_work_records: bool,
}

/// Whether the record may be voided after 운영 시작. `as_of` is the KST date
/// the window is measured at (the request's filing date when a second person
/// decides later, so the decision cannot age the request out).
///
/// # Errors
/// 409 with one of the `EMPLOYEE_*` codes above.
pub fn void_basis(
    facts: VoidFacts<'_>,
    as_of: Date,
    window_days: i64,
    attest_never_worked: bool,
) -> Result<VoidBasis, KernelError> {
    let refuse = |code: &'static str, message: &str| {
        Err(KernelError::conflict(message.to_owned()).with_code(code))
    };
    if facts.employment_status == "VOIDED" {
        return refuse(EMPLOYEE_ALREADY_VOIDED, "this registration is already void");
    }
    if facts.has_work_records {
        return refuse(EMPLOYEE_VOID_HAS_WORK_RECORDS, WORKED);
    }
    if facts.employment_status == "PRE_HIRE" {
        return Ok(VoidBasis::NeverStarted);
    }
    let age = (as_of - facts.registered_on).whole_days();
    let fresh = matches!(facts.employment_status, "ACTIVE" | "UNKNOWN") && age < window_days;
    match (fresh, attest_never_worked) {
        (true, true) => Ok(VoidBasis::AttestedWithinWindow),
        (true, false) => refuse(
            EMPLOYEE_VOID_ATTESTATION_REQUIRED,
            "a started registration is voided only when you confirm nobody worked (근무한 적 없음)",
        ),
        (false, _) => refuse(EMPLOYEE_VOID_NOT_ELIGIBLE, WORKED),
    }
}

/// The last day the 근로자 명부 must be kept: `years` after the exit day.
#[must_use]
pub fn register_kept_until(exit_on: Date, years: i32) -> Date {
    let year = exit_on.year() + years;
    Date::from_calendar_date(year, exit_on.month(), exit_on.day())
        .unwrap_or_else(|_| last_day(year, exit_on.month()))
}

fn last_day(year: i32, month: Month) -> Date {
    let day = month.length(year);
    Date::from_calendar_date(year, month, day).unwrap_or(Date::MIN)
}

/// A SETUP delete of an EXITED person still inside the register period
/// needs the actor's confirmation that the tenant keeps its original 명부
/// (onboarding design §7.3, RI#38).
///
/// # Errors
/// 409 `exited_register_confirmation_required`.
pub fn check_setup_delete(
    exit_on: Option<Date>,
    today: Date,
    register_years: i32,
    register_kept: bool,
) -> Result<(), KernelError> {
    match exit_on {
        Some(exit_on) if today <= register_kept_until(exit_on, register_years) && !register_kept => {
            Err(KernelError::conflict(format!(
                "이 퇴사자는 명부 보존 대상(퇴직일+{register_years}년)입니다. 원본 명부를 보관 중인지 확인하십시오"
            ))
            .with_code(EXITED_REGISTER_CONFIRMATION_REQUIRED))
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests;
