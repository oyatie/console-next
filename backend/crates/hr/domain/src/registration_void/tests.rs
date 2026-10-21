use time::macros::date;

use super::*;

fn facts(status: &str, worked: bool) -> VoidFacts<'_> {
    VoidFacts {
        employment_status: status,
        registered_on: date!(2026 - 10 - 01),
        has_work_records: worked,
    }
}

fn code(result: Result<VoidBasis, KernelError>) -> Option<&'static str> {
    result.err().and_then(|error| error.code)
}

#[test]
fn void_needs_a_record_nobody_worked_on() {
    let today = date!(2026 - 10 - 06);
    assert_eq!(
        void_basis(facts("PRE_HIRE", false), today, 14, false).unwrap(),
        VoidBasis::NeverStarted
    );
    assert_eq!(
        void_basis(facts("ACTIVE", false), today, 14, true).unwrap(),
        VoidBasis::AttestedWithinWindow
    );
    assert_eq!(
        code(void_basis(facts("ACTIVE", false), today, 14, false)),
        Some(EMPLOYEE_VOID_ATTESTATION_REQUIRED)
    );
    // Day 14 is outside a 14-day window (strictly under P14D old).
    assert_eq!(
        code(void_basis(
            facts("ACTIVE", false),
            date!(2026 - 10 - 15),
            14,
            true
        )),
        Some(EMPLOYEE_VOID_NOT_ELIGIBLE)
    );
    for status in ["EXITED", "ON_LEAVE"] {
        assert_eq!(
            code(void_basis(facts(status, false), today, 14, true)),
            Some(EMPLOYEE_VOID_NOT_ELIGIBLE)
        );
    }
    assert_eq!(
        code(void_basis(facts("PRE_HIRE", true), today, 14, true)),
        Some(EMPLOYEE_VOID_HAS_WORK_RECORDS)
    );
    assert_eq!(
        code(void_basis(facts("VOIDED", false), today, 14, true)),
        Some(EMPLOYEE_ALREADY_VOIDED)
    );
}

#[test]
fn the_register_is_kept_three_years_from_the_exit_day() {
    assert_eq!(
        register_kept_until(date!(2024 - 03 - 31), 3),
        date!(2027 - 03 - 31)
    );
    // 민법 §160③: no 29 February in 2027, so the month's last day.
    assert_eq!(
        register_kept_until(date!(2024 - 02 - 29), 3),
        date!(2027 - 02 - 28)
    );
    let exit = Some(date!(2024 - 03 - 31));
    assert_eq!(
        check_setup_delete(exit, date!(2027 - 03 - 31), 3, false)
            .unwrap_err()
            .code,
        Some(EXITED_REGISTER_CONFIRMATION_REQUIRED)
    );
    assert!(check_setup_delete(exit, date!(2027 - 03 - 31), 3, true).is_ok());
    assert!(check_setup_delete(exit, date!(2027 - 04 - 01), 3, false).is_ok());
    assert!(check_setup_delete(None, date!(2027 - 04 - 01), 3, false).is_ok());
}
