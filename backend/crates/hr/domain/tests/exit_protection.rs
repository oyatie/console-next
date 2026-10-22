// SPDX-License-Identifier: LicenseRef-Proprietary
//! Protected-period boundaries and the fail-closed statutory lookup.
use console_hr_domain::exits::protection::{
    AppliedExitEvent, ProtectionRegister, ProtectionRule, protected_periods,
};
use console_hr_domain::lifecycle::childcare::AppliedEvent;
use console_hr_domain::lifecycle::leave_facts::check_leave_facts;
use time::{Date, macros::date};
use uuid::Uuid;

struct Register {
    tail: Option<i64>,
}
impl ProtectionRegister for Register {
    fn rule(&self, code: &str) -> Option<ProtectionRule> {
        self.tail.map(|tail| ProtectionRule {
            tail_days: Some(if code == "CHILDCARE_LEAVE_DISMISSAL_TAIL_DAYS" {
                0
            } else {
                tail
            }),
            instrument: if code == "CHILDCARE_LEAVE_DISMISSAL_TAIL_DAYS" {
                "남녀고용평등법"
            } else {
                "근로기준법"
            }
            .into(),
            article: if code == "CHILDCARE_LEAVE_DISMISSAL_TAIL_DAYS" {
                "제19조제3항"
            } else {
                "제23조제2항"
            }
            .into(),
        })
    }
}
fn ev(kind: &'static str, leave: Option<&'static str>, on: Date) -> AppliedExitEvent<'static> {
    AppliedExitEvent {
        lifecycle_event_id: Uuid::from_u128(1),
        event: AppliedEvent {
            event_type: kind,
            leave_type: leave,
            effective_date: on,
            expected_return_date: None,
        },
    }
}
fn spans(
    kind: &'static str,
    returned: Date,
) -> Vec<console_hr_domain::exits::protection::ProtectedPeriod> {
    protected_periods(
        &[
            ev("LEAVE_OF_ABSENCE", Some(kind), date!(2026 - 01 - 01)),
            ev("RETURN_FROM_LEAVE", None, returned),
        ],
        &Register { tail: Some(30) },
    )
}
#[test]
fn d1_maternity_includes_the_last_tail_day_and_reads_the_register() {
    let p = spans("MATERNITY", date!(2026 - 04 - 01));
    assert_eq!(p[0].leave_until, Some(date!(2026 - 03 - 31)));
    assert_eq!(p[0].protected_until, Some(date!(2026 - 04 - 30)));
    assert!(p[0].blocks(date!(2026 - 04 - 30)));
    assert!(!p[0].blocks(date!(2026 - 05 - 01)));
    assert_eq!(p[0].instrument.as_deref(), Some("근로기준법"));
    assert_eq!(p[0].article.as_deref(), Some("제23조제2항"));
    let p = protected_periods(
        &[
            ev("LEAVE_OF_ABSENCE", Some("MATERNITY"), date!(2026 - 01 - 01)),
            ev("RETURN_FROM_LEAVE", None, date!(2026 - 04 - 01)),
        ],
        &Register { tail: Some(31) },
    );
    assert!(
        p[0].blocks(date!(2026 - 05 - 01)),
        "no day-count literal in the fold"
    );
}
#[test]
fn d2_open_work_injury_blocks_from_the_first_day() {
    let p = protected_periods(
        &[ev(
            "LEAVE_OF_ABSENCE",
            Some("WORK_INJURY"),
            date!(2026 - 01 - 01),
        )],
        &Register { tail: Some(30) },
    );
    assert_eq!(p[0].protected_until, None);
    assert!(p[0].blocks(date!(2099 - 01 - 01)));
    assert!(!p[0].blocks(date!(2025 - 12 - 31)));
}
#[test]
fn d3_childcare_has_no_tail() {
    let p = spans("CHILDCARE", date!(2026 - 07 - 01));
    assert!(p[0].blocks(date!(2026 - 06 - 30)));
    assert!(!p[0].blocks(date!(2026 - 07 - 01)));
    assert_eq!(p[0].article.as_deref(), Some("제19조제3항"));
}
#[test]
fn d4_ordinary_and_future_leave_do_not_block() {
    for kind in ["ILLNESS", "PERSONAL"] {
        assert!(spans(kind, date!(2026 - 07 - 01)).is_empty());
    }
    assert!(!spans("MATERNITY", date!(2026 - 04 - 01))[0].blocks(date!(2025 - 12 - 31)));
}
#[test]
fn d5_missing_rule_is_open_even_after_a_return() {
    let p = protected_periods(
        &[
            ev("LEAVE_OF_ABSENCE", Some("MATERNITY"), date!(2026 - 01 - 01)),
            ev("RETURN_FROM_LEAVE", None, date!(2026 - 04 - 01)),
        ],
        &Register { tail: None },
    );
    assert!(p[0].blocks(date!(2099 - 01 - 01)));
    assert_eq!(p[0].protected_until, None);
}
#[test]
fn expected_return_and_termination_close_the_leave() {
    let mut leave = ev("LEAVE_OF_ABSENCE", Some("CHILDCARE"), date!(2026 - 01 - 01));
    leave.event.expected_return_date = Some(date!(2026 - 07 - 01));
    let p = protected_periods(&[leave], &Register { tail: Some(30) });
    assert_eq!(p[0].leave_until, Some(date!(2026 - 06 - 30)));
    let p = protected_periods(
        &[leave, ev("TERMINATE", None, date!(2026 - 03 - 01))],
        &Register { tail: Some(30) },
    );
    assert_eq!(p[0].leave_until, Some(date!(2026 - 02 - 28)));
}
#[test]
fn d8_work_injury_does_not_require_a_return_date() {
    assert!(check_leave_facts(Some("WORK_INJURY"), None).is_ok());
    assert_eq!(
        check_leave_facts(Some("VACATION"), None)
            .err()
            .and_then(|e| e.code),
        Some("leave_type_invalid")
    );
}

#[test]
fn an_unrepresentable_register_tail_stays_open() {
    let p = protected_periods(
        &[
            ev("LEAVE_OF_ABSENCE", Some("MATERNITY"), date!(2026 - 01 - 01)),
            ev("RETURN_FROM_LEAVE", None, date!(2026 - 04 - 01)),
        ],
        &Register {
            tail: Some(i64::MAX),
        },
    );
    assert!(p[0].blocks(date!(2099 - 01 - 01)));
    assert_eq!(p[0].protected_until, None);
}
