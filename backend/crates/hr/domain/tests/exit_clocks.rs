//! BW-05 clock fixture table (decisions #9, framework C3 anchor 5).
//! The rule values here are the register's current HOLD readings; production
//! code never carries them.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_hr_domain::exits::clocks::{
    ExitClockRules, LossReportMonthAnchor, check_snooze, dismissal_notice_pay_owed, due_after_days,
    exit_clocks,
};
use console_kernel_core::ErrorKind;
use time::macros::date;

const HOLD: ExitClockRules = ExitClockRules {
    final_pay_days: 14,
    severance_pay_days: 14,
    insurance_loss_offset_days: 1,
    ei_nps_report_day: 15,
    ei_nps_report_anchor: LossReportMonthAnchor::ExitDate,
    nhis_report_days: 14,
    dismissal_notice_days: 30,
    dismissal_notice_min_service_months: 3,
};

#[test]
fn exit_9_20_final_pay_due_10_4() {
    let c = exit_clocks(date!(2026 - 09 - 20), &HOLD).unwrap();
    assert_eq!(c.final_pay_due, date!(2026 - 10 - 04));
    assert_eq!(c.final_payslip_due, date!(2026 - 10 - 04));
    assert_eq!(c.severance_due, date!(2026 - 10 - 04));
    assert_eq!(c.mid_year_tax_settlement_due, date!(2026 - 10 - 04));
    assert_eq!(c.ei_nps_loss_report_due, date!(2026 - 10 - 15));
}

#[test]
fn exit_9_30_per_insurer_earlier_reading() {
    let c = exit_clocks(date!(2026 - 09 - 30), &HOLD).unwrap();
    assert_eq!(c.insurance_loss_date, date!(2026 - 10 - 01));
    assert_eq!(c.ei_nps_loss_report_due, date!(2026 - 10 - 15));
    assert_eq!(c.nhis_loss_report_due, date!(2026 - 10 - 14));
    assert_eq!(c.final_pay_due, date!(2026 - 10 - 14));
}

#[test]
fn loss_date_anchor_relaxes_only_month_end_exits() {
    let relaxed = ExitClockRules {
        ei_nps_report_anchor: LossReportMonthAnchor::LossDate,
        ..HOLD
    };
    let month_end = exit_clocks(date!(2026 - 09 - 30), &relaxed).unwrap();
    assert_eq!(month_end.ei_nps_loss_report_due, date!(2026 - 11 - 15));
    let mid_month = exit_clocks(date!(2026 - 09 - 29), &relaxed).unwrap();
    assert_eq!(mid_month.ei_nps_loss_report_due, date!(2026 - 10 - 15));
}

#[test]
fn december_exit_rolls_into_next_year() {
    let c = exit_clocks(date!(2026 - 12 - 31), &HOLD).unwrap();
    assert_eq!(c.insurance_loss_date, date!(2027 - 01 - 01));
    assert_eq!(c.ei_nps_loss_report_due, date!(2027 - 01 - 15));
    assert_eq!(c.nhis_loss_report_due, date!(2027 - 01 - 14));
    assert_eq!(c.final_pay_due, date!(2027 - 01 - 14));
}

#[test]
fn report_day_missing_from_due_month_is_a_validation_error() {
    let bad = ExitClockRules {
        ei_nps_report_day: 30,
        ..HOLD
    };
    let err = exit_clocks(date!(2027 - 01 - 10), &bad).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Validation);
}

#[test]
fn notice_gap_under_30_days_owes_the_line() {
    let hire = date!(2025 - 01 - 01);
    let exit = date!(2026 - 09 - 30);
    let owed = |notice| dismissal_notice_pay_owed(hire, notice, exit, &HOLD).unwrap();
    assert!(owed(Some(date!(2026 - 09 - 01))), "29 days is short");
    assert!(!owed(Some(date!(2026 - 08 - 31))), "30 days is enough");
    assert!(owed(None), "no notice at all is short");
    assert!(
        owed(Some(date!(2026 - 10 - 05))),
        "notice after exit is short"
    );
}

#[test]
fn notice_line_needs_three_months_of_service_to_the_loss_date() {
    let exit = date!(2026 - 09 - 30);
    let owed = |hire| dismissal_notice_pay_owed(hire, None, exit, &HOLD).unwrap();
    assert!(
        owed(date!(2026 - 07 - 01)),
        "7/1 + 3 months = 10/1 = loss date"
    );
    assert!(!owed(date!(2026 - 07 - 02)));
}

#[test]
fn notice_service_months_clamp_to_month_end() {
    let hire = date!(2025 - 11 - 30);
    let owed = |exit| dismissal_notice_pay_owed(hire, None, exit, &HOLD).unwrap();
    assert!(owed(date!(2026 - 02 - 27)), "11/30 + 3 months = 2/28");
    assert!(!owed(date!(2026 - 02 - 26)));
}

#[test]
fn event_clocks_start_from_their_event() {
    let requested = date!(2026 - 10 - 02);
    assert_eq!(
        due_after_days(requested, 0).unwrap(),
        requested,
        "사용증명서 즉시"
    );
    assert_eq!(
        due_after_days(requested, 10).unwrap(),
        date!(2026 - 10 - 12)
    );
}

#[test]
fn snooze_cannot_pass_the_due_date() {
    let due = date!(2026 - 10 - 15);
    assert!(check_snooze(due, due).is_ok());
    assert!(check_snooze(date!(2026 - 10 - 14), due).is_ok());
    let err = check_snooze(date!(2026 - 10 - 16), due).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Validation);
}
