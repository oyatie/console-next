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
    fn rule(&self, leave_type: &str) -> Option<ProtectionRule> {
        let (tail_days, instrument, article) = match leave_type {
            "WORK_INJURY" | "MATERNITY" => (self.tail, "근로기준법", "제23조제2항"),
            "CHILDCARE" => (self.tail.map(|_| 0), "남녀고용평등법", "제19조제3항"),
            _ => return None,
        };
        Some(ProtectionRule {
            tail_days,
            instrument: instrument.into(),
            article: article.into(),
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
fn protection_mapping_covers_the_existing_three_leave_types() {
    for kind in ["WORK_INJURY", "MATERNITY", "CHILDCARE"] {
        let p = spans(kind, date!(2026 - 04 - 01));
        assert_eq!(p.len(), 1, "{kind} remains protected");
        assert_eq!(p[0].leave_type, kind);
    }
    assert!(spans("ILLNESS", date!(2026 - 04 - 01)).is_empty());
}
#[test]
fn the_register_owns_which_leave_type_is_protected() {
    struct Remapped;
    impl ProtectionRegister for Remapped {
        fn rule(&self, leave_type: &str) -> Option<ProtectionRule> {
            (leave_type == "PERSONAL").then(|| ProtectionRule {
                tail_days: None,
                instrument: "fixture".into(),
                article: "fixture".into(),
            })
        }
    }
    let protected = ev("LEAVE_OF_ABSENCE", Some("PERSONAL"), date!(2026 - 01 - 01));
    let unprotected = ev("LEAVE_OF_ABSENCE", Some("MATERNITY"), date!(2026 - 01 - 01));
    assert_eq!(protected_periods(&[protected], &Remapped).len(), 1);
    assert!(protected_periods(&[unprotected], &Remapped).is_empty());
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
