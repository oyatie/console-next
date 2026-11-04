// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use console_payroll_domain::pay_groups::{
    run_schedule::{derive_schedule, next_attribution_month},
    *,
};
use time::{Date, Month, macros::date};

fn period(start_day: PeriodStart, month_offset: i8) -> PeriodRule {
    PeriodRule {
        start_day,
        month_offset,
    }
}

#[test]
fn each_pay_day_and_month_offset_clamps_across_leap_year_and_year_end() {
    for (month, expected) in [
        (date!(2026 - 02 - 01), date!(2026 - 02 - 28)),
        (date!(2028 - 02 - 01), date!(2028 - 02 - 29)),
        (date!(2026 - 12 - 01), date!(2026 - 12 - 31)),
    ] {
        for day in [PayDay::Day(31), PayDay::LastDay] {
            for offset in [0, 1] {
                let attribution = if offset == 1 {
                    month.previous_day().unwrap().replace_day(1).unwrap()
                } else {
                    month
                };
                let result = derive_schedule(
                    attribution,
                    PayDateRule {
                        day,
                        month_offset: offset,
                        non_business_day: NonBusinessDay::Next,
                    },
                    period(PeriodStart::First, 0),
                    period(PeriodStart::Day(16), -1),
                    |_| Ok(true),
                )
                .unwrap();
                assert_eq!(result.pay_date, expected);
                assert_eq!(
                    result.pay_date_clamped,
                    day == PayDay::Day(31) && expected.day() < 31
                );
                assert_eq!(result.base_start, attribution);
                assert_eq!(result.base_end, month_end(attribution));
                assert_eq!(result.variable_start.day(), 16);
                assert_eq!(result.variable_end, attribution.replace_day(15).unwrap());
            }
        }
    }
}

fn month_end(month: Date) -> Date {
    let (year, next) = if month.month() == Month::December {
        (month.year() + 1, Month::January)
    } else {
        (month.year(), month.month().next())
    };
    Date::from_calendar_date(year, next, 1)
        .unwrap()
        .previous_day()
        .unwrap()
}

#[test]
fn every_kind_uses_its_own_first_unoccupied_month_sequence() {
    let today = date!(2026 - 11 - 19);
    assert_eq!(
        next_attribution_month(today, &[]).unwrap(),
        date!(2026 - 11 - 01)
    );
    assert_eq!(
        next_attribution_month(today, &[date!(2026 - 11 - 01), date!(2027 - 01 - 01)]).unwrap(),
        date!(2026 - 12 - 01)
    );
}

#[test]
fn adjustments_use_the_supplied_calendar_in_both_directions_including_year_crossing() {
    for (direction, expected) in [
        (NonBusinessDay::Previous, date!(2026 - 12 - 31)),
        (NonBusinessDay::Next, date!(2027 - 01 - 04)),
    ] {
        let result = derive_schedule(
            date!(2026 - 12 - 01),
            PayDateRule {
                day: PayDay::Day(1),
                month_offset: 1,
                non_business_day: direction,
            },
            period(PeriodStart::First, 0),
            period(PeriodStart::First, 0),
            |day| {
                Ok(![
                    date!(2027 - 01 - 01),
                    date!(2027 - 01 - 02),
                    date!(2027 - 01 - 03),
                ]
                .contains(&day))
            },
        )
        .unwrap();
        assert_eq!(result.pay_date, expected);
    }
}

#[test]
fn every_period_rule_starts_on_the_named_day_and_ends_before_the_next_start() {
    for start_day in [
        PeriodStart::First,
        PeriodStart::Day(1),
        PeriodStart::Day(16),
        PeriodStart::Day(28),
    ] {
        for offset in [-1, 0] {
            let result = derive_schedule(
                date!(2028 - 03 - 01),
                PayDateRule {
                    day: PayDay::Day(15),
                    month_offset: 0,
                    non_business_day: NonBusinessDay::Previous,
                },
                period(start_day, offset),
                period(start_day, offset),
                |_| Ok(true),
            )
            .unwrap();
            let day = match start_day {
                PeriodStart::First => 1,
                PeriodStart::Day(day) => day,
            };
            assert_eq!(
                result.base_start,
                Date::from_calendar_date(
                    2028,
                    if offset == -1 {
                        Month::February
                    } else {
                        Month::March
                    },
                    day
                )
                .unwrap()
            );
            assert_eq!(result.base_end.next_day().unwrap().day(), day);
            assert_eq!(
                (result.variable_start, result.variable_end),
                (result.base_start, result.base_end)
            );
        }
    }
}

#[test]
fn calendar_errors_and_invalid_rules_are_never_defaulted() {
    let pay = PayDateRule {
        day: PayDay::LastDay,
        month_offset: 0,
        non_business_day: NonBusinessDay::Next,
    };
    let base = period(PeriodStart::First, 0);
    let error = derive_schedule(date!(2026 - 11 - 01), pay, base, base, |_| {
        Err(
            console_kernel_core::KernelError::unavailable("missing calendar")
                .with_code("holiday_calendar_missing"),
        )
    })
    .unwrap_err();
    assert_eq!(error.code, Some("holiday_calendar_missing"));
    assert!(derive_schedule(date!(2026 - 11 - 02), pay, base, base, |_| Ok(true)).is_err());
    assert!(
        derive_schedule(
            date!(2026 - 11 - 01),
            PayDateRule {
                month_offset: 2,
                ..pay
            },
            base,
            base,
            |_| Ok(true)
        )
        .is_err()
    );
    assert!(
        derive_schedule(
            date!(2026 - 11 - 01),
            pay,
            period(PeriodStart::Day(29), 0),
            base,
            |_| Ok(true)
        )
        .is_err()
    );
    assert!(
        derive_schedule(
            date!(2026 - 11 - 01),
            pay,
            base,
            period(PeriodStart::First, -2),
            |_| Ok(true)
        )
        .is_err()
    );
}
