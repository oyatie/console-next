//! LC-B3 `case_clocks`: the EXIT rows' clocks equal `exit_clocks` for the same
//! register numbers, SF's `ins.deadline.*` keys are answered by the register,
//! and an unverified or unanchored rule never becomes a date.
//! The numbers here are the register's current HOLD readings; production code
//! never carries them.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{BTreeMap, HashMap};

use console_hr_domain::cases::clocks::{
    Anchor, Anchors, Clock, DueRegister, DueRule, RegisterUnit, RegisterValue, case_clocks,
};
use console_hr_domain::exits::clocks::{ExitClockRules, LossReportMonthAnchor, exit_clocks};

#[test]
fn complete_filing_clock_precedes_the_legacy_scalar_and_errors_fail_closed() {
    struct Complete(bool);
    impl DueRegister for Complete {
        fn value(
            &self,
            _: &str,
            _: Date,
        ) -> Result<RegisterValue, console_kernel_core::KernelError> {
            panic!("the complete filing clock owns this obligation");
        }
        fn filing_clock(
            &self,
            _: &str,
            _: &Anchors,
        ) -> Result<Option<Clock>, console_kernel_core::KernelError> {
            if self.0 {
                Err(console_kernel_core::KernelError::validation(
                    "unverified clock",
                ))
            } else {
                Ok(Some(Clock::Due {
                    date: date!(2026 - 10 - 14),
                    held: true,
                }))
            }
        }
    }
    let rule = DueRule::parse(
        Some("EXIT_DATE"),
        "DAYS_AFTER",
        Some("NHIS_LOSS_REPORT_DUE_DAYS"),
    )
    .unwrap();
    let a = Anchors(BTreeMap::from([(Anchor::ExitDate, date!(2026 - 09 - 30))]));
    assert_eq!(
        case_clocks(std::slice::from_ref(&rule), &a, &Complete(false)),
        [Clock::Due {
            date: date!(2026 - 10 - 14),
            held: true
        }]
    );
    assert!(matches!(
        case_clocks(&[rule], &a, &Complete(true))[0],
        Clock::Unresolved(_)
    ));
}
use console_kernel_core::KernelError;
use time::Date;
use time::macros::date;

struct Register(HashMap<&'static str, (RegisterUnit, u16)>);

impl DueRegister for Register {
    fn value(&self, code: &str, _on: Date) -> Result<RegisterValue, KernelError> {
        self.0
            .get(code)
            .map(|&(unit, value)| RegisterValue {
                unit,
                value,
                held: true,
            })
            .ok_or_else(|| KernelError::not_found(format!("no statutory rule {code}")))
    }
}

fn register() -> Register {
    Register(HashMap::from([
        ("FINAL_PAY_DUE_DAYS", (RegisterUnit::Days, 14)),
        ("SEVERANCE_PAY_DUE_DAYS", (RegisterUnit::Days, 14)),
        ("DISMISSAL_NOTICE_DAYS", (RegisterUnit::Days, 30)),
        ("UNFAIR_DISMISSAL_CLAIM_MONTHS", (RegisterUnit::Months, 3)),
        // The SF keys, answered as the compliance register answers them (aliases).
        ("ins.deadline.lose.ei", (RegisterUnit::DayOfNextMonth, 15)),
        ("ins.deadline.lose.nps", (RegisterUnit::DayOfNextMonth, 15)),
        ("ins.deadline.lose.nhis", (RegisterUnit::Days, 14)),
        ("SEPARATION_CERTIFICATE_DUE_DAYS", (RegisterUnit::Days, 10)),
    ]))
}

fn rule(anchor: Option<&str>, kind: &str, code: Option<&str>) -> DueRule {
    DueRule::parse(anchor, kind, code).unwrap()
}

fn exit_anchors(exit: Date) -> Anchors {
    Anchors(BTreeMap::from([
        (Anchor::ExitDate, exit),
        (Anchor::LossDate, exit.next_day().unwrap()),
    ]))
}

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
fn exit_rows_match_exit_clocks_for_the_same_numbers() {
    let rules = [
        rule(Some("EXIT_DATE"), "DAYS_AFTER", Some("FINAL_PAY_DUE_DAYS")), // X6
        rule(
            Some("EXIT_DATE"),
            "DAYS_AFTER",
            Some("SEVERANCE_PAY_DUE_DAYS"),
        ), // X7
        rule(
            Some("EXIT_DATE"),
            "DAY_OF_NEXT_MONTH",
            Some("ins.deadline.lose.nps"),
        ), // X9
        rule(
            Some("EXIT_DATE"),
            "DAYS_AFTER",
            Some("ins.deadline.lose.nhis"),
        ), // X10
        rule(
            Some("EXIT_DATE"),
            "DAY_OF_NEXT_MONTH",
            Some("ins.deadline.lose.ei"),
        ), // X11
    ];
    for exit in [
        date!(2026 - 09 - 20),
        date!(2026 - 09 - 30),
        date!(2026 - 12 - 31),
        date!(2027 - 01 - 31),
    ] {
        let old = exit_clocks(exit, &HOLD).unwrap();
        let new = case_clocks(&rules, &exit_anchors(exit), &register());
        let dates: Vec<Date> = new
            .iter()
            .map(|c| match c {
                Clock::Due { date, held: true } => *date,
                other => panic!("{exit}: {other:?}"),
            })
            .collect();
        assert_eq!(
            dates,
            [
                old.final_pay_due,
                old.severance_due,
                old.ei_nps_loss_report_due,
                old.nhis_loss_report_due,
                old.ei_nps_loss_report_due
            ],
            "{exit}"
        );
    }
}

#[test]
fn every_rule_kind_counts_from_its_anchor() {
    let exit = date!(2026 - 11 - 30);
    let rules = [
        rule(
            Some("EXIT_DATE"),
            "DAYS_BEFORE",
            Some("DISMISSAL_NOTICE_DAYS"),
        ), // DM2
        rule(
            Some("EXIT_DATE"),
            "MONTHS_AFTER",
            Some("UNFAIR_DISMISSAL_CLAIM_MONTHS"),
        ), // DM5
        rule(Some("EXIT_DATE"), "END_OF_NEXT_MONTH", None), // X14
        rule(Some("EXIT_DATE"), "IMMEDIATE", None),         // X1
        rule(Some("EXIT_DATE"), "WITHOUT_DELAY", None),     // X2
    ];
    let clocks = case_clocks(&rules, &exit_anchors(exit), &register());
    assert_eq!(
        clocks,
        [
            Clock::Due {
                date: date!(2026 - 10 - 31),
                held: true
            },
            // 민법 §160③: 11/30 + 3 months = the last day of February.
            Clock::Due {
                date: date!(2027 - 02 - 28),
                held: true
            },
            Clock::Due {
                date: date!(2026 - 12 - 31),
                held: false
            },
            Clock::Due {
                date: exit,
                held: false
            },
            Clock::WithoutDelay { since: exit },
        ]
    );
}

#[test]
fn an_unverified_rule_never_becomes_a_date() {
    // [U] rows (DMg2, TE1, X3) are UNKNOWN: 「기한 미확인」 whatever the anchors.
    let unknown = rule(None, "UNKNOWN", None);
    let clocks = case_clocks(
        &[unknown],
        &exit_anchors(date!(2026 - 10 - 01)),
        &register(),
    );
    assert_eq!(clocks, [Clock::Unknown]);
    // An UNKNOWN rule cannot be given an anchor or a register number either.
    assert!(DueRule::parse(Some("EXIT_DATE"), "UNKNOWN", None).is_err());
    assert!(DueRule::parse(None, "UNKNOWN", Some("FINAL_PAY_DUE_DAYS")).is_err());
    // A numbered rule needs both; a numberless one takes no code.
    assert!(DueRule::parse(Some("EXIT_DATE"), "DAYS_AFTER", None).is_err());
    assert!(DueRule::parse(Some("EXIT_DATE"), "IMMEDIATE", Some("FINAL_PAY_DUE_DAYS")).is_err());
    assert!(DueRule::parse(Some("NEXT_TUESDAY"), "IMMEDIATE", None).is_err());
    assert!(DueRule::parse(Some("EXIT_DATE"), "SOON", None).is_err());
}

#[test]
fn a_request_triggered_item_waits_and_a_register_gap_fails_closed() {
    let x12 = rule(
        Some("REQUEST_DATE"),
        "DAYS_AFTER",
        Some("SEPARATION_CERTIFICATE_DUE_DAYS"),
    );
    let anchors = exit_anchors(date!(2026 - 10 - 01));
    assert_eq!(
        case_clocks(std::slice::from_ref(&x12), &anchors, &register()),
        [Clock::AwaitingAnchor(Anchor::RequestDate)]
    );
    let mut requested = anchors.clone();
    requested
        .0
        .insert(Anchor::RequestDate, date!(2026 - 10 - 05));
    assert_eq!(
        case_clocks(&[x12], &requested, &register()),
        [Clock::Due {
            date: date!(2026 - 10 - 15),
            held: true
        }]
    );
    // No register row (a key SF has not minted), or a row in the wrong unit.
    let missing = rule(
        Some("EXIT_DATE"),
        "DAYS_AFTER",
        Some("ins.deadline.acquire.nps"),
    );
    let wrong_unit = rule(
        Some("EXIT_DATE"),
        "DAYS_AFTER",
        Some("ins.deadline.lose.ei"),
    );
    let clocks = case_clocks(&[missing, wrong_unit], &anchors, &register());
    assert!(
        clocks.iter().all(|c| matches!(c, Clock::Unresolved(_))),
        "{clocks:?}"
    );
}
