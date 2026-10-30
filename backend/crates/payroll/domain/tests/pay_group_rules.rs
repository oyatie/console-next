// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use console_payroll_domain::pay_groups::*;

#[test]
fn pay_date_accepts_only_calendar_days_and_current_or_next_month() {
    for direction in [NonBusinessDay::Previous, NonBusinessDay::Next] {
        for day in [PayDay::Day(1), PayDay::Day(31), PayDay::LastDay] {
            for month_offset in [0, 1] {
                assert!(
                    PayDateRule {
                        day,
                        month_offset,
                        non_business_day: direction
                    }
                    .validate()
                    .is_ok()
                );
            }
        }
    }
    for (day, month_offset) in [
        (PayDay::Day(0), 0),
        (PayDay::Day(32), 0),
        (PayDay::LastDay, 2),
    ] {
        let error = PayDateRule {
            day,
            month_offset,
            non_business_day: NonBusinessDay::Next,
        }
        .validate()
        .unwrap_err();
        assert_eq!(error.field.as_deref(), Some("pay_date_rule"));
    }
}

#[test]
fn each_period_requires_a_supported_start_and_month() {
    for field in ["base_period", "variable_period"] {
        for start_day in [
            PeriodStart::Day(1),
            PeriodStart::Day(28),
            PeriodStart::First,
        ] {
            for month_offset in [-1, 0] {
                assert!(
                    PeriodRule {
                        start_day,
                        month_offset
                    }
                    .validate(field)
                    .is_ok()
                );
            }
        }
        for (start_day, month_offset) in [
            (PeriodStart::Day(0), 0),
            (PeriodStart::Day(29), 0),
            (PeriodStart::First, -2),
            (PeriodStart::First, 1),
        ] {
            let error = PeriodRule {
                start_day,
                month_offset,
            }
            .validate(field)
            .unwrap_err();
            assert_eq!(error.field.as_deref(), Some(field));
        }
    }
}
