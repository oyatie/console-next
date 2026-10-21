//! BW-35 headcount-class fixtures (근로기준법 시행령 §7의2, decisions #3).
//! The rule values here are the register's current HOLD readings; production
//! code never carries them.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_hr_domain::employee::headcount::{
    HeadcountRules, RosterSpan, computation_period, headcount_class,
};
use console_kernel_core::ErrorKind;
use time::Date;
use time::macros::date;

const HOLD: HeadcountRules = HeadcountRules {
    threshold: 5,
    lookback_months: 1,
};
const LONG_AGO: Date = date!(2020 - 01 - 01);
const EVENT: Date = date!(2026 - 10 - 15);
/// Four 가동일 inside the 9/15–10/14 period.
const DAYS: [Date; 4] = [
    date!(2026 - 10 - 06),
    date!(2026 - 10 - 07),
    date!(2026 - 10 - 08),
    date!(2026 - 10 - 09),
];

fn workers(n: usize, first_day: Date, last_day: Option<Date>) -> Vec<RosterSpan> {
    vec![
        RosterSpan {
            first_day,
            last_day,
            cohabiting_relative: false,
        };
        n
    ]
}

#[test]
fn period_is_the_month_before_the_event() {
    let p = computation_period(EVENT, LONG_AGO, &HOLD).unwrap();
    assert_eq!(p, (date!(2026 - 09 - 15), date!(2026 - 10 - 14)));
}

#[test]
fn period_starts_no_earlier_than_establishment() {
    let p = computation_period(EVENT, date!(2026 - 10 - 01), &HOLD).unwrap();
    assert_eq!(p, (date!(2026 - 10 - 01), date!(2026 - 10 - 14)));
}

#[test]
fn month_end_event_rolls_missing_start_day_forward() {
    let p = computation_period(date!(2026 - 03 - 31), LONG_AGO, &HOLD).unwrap();
    assert_eq!(p, (date!(2026 - 03 - 01), date!(2026 - 03 - 30)));
}

#[test]
fn established_on_or_after_event_is_refused() {
    for established in [EVENT, date!(2026 - 10 - 16)] {
        let err = computation_period(EVENT, established, &HOLD).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Validation);
    }
}

#[test]
fn exactly_at_threshold_meets_it_one_below_does_not() {
    let five = headcount_class(EVENT, LONG_AGO, &DAYS, &workers(5, LONG_AGO, None), &HOLD).unwrap();
    assert_eq!((five.person_days, five.operating_days), (20, 4));
    assert!(five.average_meets_threshold && five.meets_threshold);
    assert_eq!(five.days_below_threshold, 0);

    let four = headcount_class(EVENT, LONG_AGO, &DAYS, &workers(4, LONG_AGO, None), &HOLD).unwrap();
    assert!(!four.average_meets_threshold && !four.meets_threshold);
    assert_eq!(four.days_below_threshold, 4);
}

#[test]
fn low_average_but_few_short_days_meets_threshold() {
    // §7의2②1: counts 5, 5, 5, 0 → average 3.75, one day of four below.
    let roster = workers(5, LONG_AGO, Some(DAYS[2]));
    let c = headcount_class(EVENT, LONG_AGO, &DAYS, &roster, &HOLD).unwrap();
    assert_eq!(c.person_days, 15);
    assert!(!c.average_meets_threshold);
    assert_eq!(c.days_below_threshold, 1);
    assert!(c.meets_threshold);
}

#[test]
fn high_average_but_half_short_days_does_not_meet_threshold() {
    // §7의2②2: counts 20, 20, 4, 4 → average 12, two days of four below.
    let mut roster = workers(4, LONG_AGO, None);
    roster.extend(workers(16, LONG_AGO, Some(DAYS[1])));
    let c = headcount_class(EVENT, LONG_AGO, &DAYS, &roster, &HOLD).unwrap();
    assert_eq!(c.person_days, 48);
    assert!(c.average_meets_threshold);
    assert_eq!(c.days_below_threshold, 2);
    assert!(!c.meets_threshold);
}

#[test]
fn spans_count_from_first_day_through_last_working_day() {
    let roster = [RosterSpan {
        first_day: DAYS[1],
        last_day: Some(DAYS[2]),
        cohabiting_relative: false,
    }];
    let c = headcount_class(EVENT, LONG_AGO, &DAYS, &roster, &HOLD).unwrap();
    assert_eq!(c.person_days, 2);
}

#[test]
fn cohabiting_relatives_count_only_alongside_another_worker() {
    let relative = RosterSpan {
        first_day: LONG_AGO,
        last_day: None,
        cohabiting_relative: true,
    };
    let alone = headcount_class(EVENT, LONG_AGO, &DAYS, &[relative; 5], &HOLD).unwrap();
    assert_eq!(alone.person_days, 0);

    let mut roster = vec![relative; 4];
    roster.extend(workers(1, LONG_AGO, None));
    let mixed = headcount_class(EVENT, LONG_AGO, &DAYS, &roster, &HOLD).unwrap();
    assert_eq!(mixed.person_days, 20);
    assert!(mixed.meets_threshold);
}

#[test]
fn bad_input_is_refused_never_defaulted() {
    let staff = workers(5, LONG_AGO, None);
    let inverted = workers(1, DAYS[2], Some(DAYS[1]));
    let cases: [(&[Date], &[RosterSpan]); 4] = [
        (&[], &staff),
        (&[date!(2026 - 10 - 15)], &staff),
        (&[DAYS[0], DAYS[0]], &staff),
        (&DAYS, &inverted),
    ];
    for (days, roster) in cases {
        let err = headcount_class(EVENT, LONG_AGO, days, roster, &HOLD).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Validation);
    }
}
