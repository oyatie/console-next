//! BW-12: cumulative fixed-term service (기간제법 §4①) and the renewal check.
//!
//! Service counts the days inside CONTRACT periods, minus CHILDCARE leave
//! (남녀고용평등법 §19⑤). Gaps between contracts do not count. The limit is a
//! statutory register value (`limit_months`, a parameter), never a constant.
//! An employee with no contract history (imported) falls back to `hire_date`
//! and needs confirmation before a renewal over the limit.

use time::{Date, Duration};

/// An inclusive date period.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DatePeriod {
    pub start: Date,
    pub end: Date,
}

impl DatePeriod {
    fn contains(&self, day: Date) -> bool {
        self.start <= day && day <= self.end
    }
}

/// What the service count was computed from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceBasis {
    ContractHistory,
    HireDateFallback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FixedTermService {
    /// Counted days up to and including `as_of`.
    pub cumulative_days: u32,
    /// Last day inside the limit, assuming uninterrupted service after the
    /// last contract ends.
    pub two_year_date: Date,
    pub basis: ServiceBasis,
}

/// The employee's fixed-term inputs. `contracts` may be empty (imported).
#[derive(Debug, Clone, Copy)]
pub struct FixedTermHistory<'a> {
    pub contracts: &'a [DatePeriod],
    pub childcare_leave: &'a [DatePeriod],
    pub hire_date: Date,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenewalVerdict {
    Within,
    /// 409 `fixed_term_limit` unless a governed `FIXED_TERM_OVER_TWO_YEARS`
    /// exception names a [`super::fixed_term_exemption::FixedTermExemption`].
    ExceedsLimit,
    /// Over the limit on the `hire_date` fallback: the adapter requires history confirmation or an exception.
    ExceedsUnverified,
}

/// Service as of `as_of` (the employee detail's `fixed_term` field).
#[must_use]
pub fn fixed_term_service(
    history: FixedTermHistory<'_>,
    as_of: Date,
    limit_months: u8,
) -> FixedTermService {
    let fallback = [DatePeriod {
        start: history.hire_date,
        end: as_of,
    }];
    let (contracts, basis) = periods(history, &fallback);
    compute(
        contracts,
        history.childcare_leave,
        as_of,
        limit_months,
        basis,
    )
}

/// Whether `renewal` keeps total service within the limit. The returned
/// service counts through `renewal.end`.
#[must_use]
pub fn check_renewal(
    history: FixedTermHistory<'_>,
    renewal: DatePeriod,
    limit_months: u8,
) -> (RenewalVerdict, FixedTermService) {
    let fallback = [DatePeriod {
        start: history.hire_date,
        end: renewal.start.previous_day().unwrap_or(renewal.start),
    }];
    let (contracts, basis) = periods(history, &fallback);
    let mut with_renewal = contracts.to_vec();
    with_renewal.push(renewal);
    let service = compute(
        &with_renewal,
        history.childcare_leave,
        renewal.end,
        limit_months,
        basis,
    );
    let verdict = match (renewal.end <= service.two_year_date, basis) {
        (true, _) => RenewalVerdict::Within,
        (false, ServiceBasis::ContractHistory) => RenewalVerdict::ExceedsLimit,
        (false, ServiceBasis::HireDateFallback) => RenewalVerdict::ExceedsUnverified,
    };
    (verdict, service)
}

fn periods<'a>(
    history: FixedTermHistory<'a>,
    fallback: &'a [DatePeriod],
) -> (&'a [DatePeriod], ServiceBasis) {
    if history.contracts.is_empty() {
        (fallback, ServiceBasis::HireDateFallback)
    } else {
        (history.contracts, ServiceBasis::ContractHistory)
    }
}

// day-by-day walk, O(days x periods); a contract history spans a few
// thousand days at most. Switch to interval arithmetic if it ever shows in a profile.
fn compute(
    contracts: &[DatePeriod],
    childcare: &[DatePeriod],
    as_of: Date,
    limit_months: u8,
    basis: ServiceBasis,
) -> FixedTermService {
    let contracts: Vec<DatePeriod> = contracts
        .iter()
        .copied()
        .filter(|p| p.start <= p.end)
        .collect();
    let first = contracts.iter().map(|p| p.start).min().unwrap_or(as_of);
    let last = contracts.iter().map(|p| p.end).max().unwrap_or(as_of);
    let on_leave = |d: Date| childcare.iter().any(|p| p.contains(d));
    let in_contract = |d: Date| contracts.iter().any(|p| p.contains(d));

    let mut cumulative_days = 0u32;
    let mut day = first;
    while day <= as_of.min(last) {
        if in_contract(day) && !on_leave(day) {
            cumulative_days += 1;
        }
        day += Duration::DAY;
    }

    // The statutory limit in days from `first` (민법 §160), then walk forward
    // until that many counted days have passed. After `last` every day counts
    // (projected service) except childcare leave.
    let needed = (period_end(first, limit_months) - first).whole_days() + 1;
    let mut counted = 0i64;
    let mut day = first;
    let two_year_date = loop {
        if (day > last || in_contract(day)) && !on_leave(day) {
            counted += 1;
            if counted >= needed {
                break day;
            }
        }
        day += Duration::DAY;
    };
    FixedTermService {
        cumulative_days,
        two_year_date,
        basis,
    }
}

/// 민법 §160②③: a period of `months` from `start` ends the day before the
/// corresponding date, or on the month's last day when there is none.
fn period_end(start: Date, months: u8) -> Date {
    let total = i32::from(u8::from(start.month())) - 1 + i32::from(months);
    let year = start.year() + total.div_euclid(12);
    let month = time::Month::January.nth_next(u8::try_from(total.rem_euclid(12)).unwrap_or(0));
    let last_day = month.length(year);
    if start.day() > last_day {
        return Date::from_calendar_date(year, month, last_day).unwrap_or(start);
    }
    Date::from_calendar_date(year, month, start.day())
        .ok()
        .and_then(Date::previous_day)
        .unwrap_or(start)
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;

    const LIMIT: u8 = 24; // 기간제법 §4①; production reads it from statutory_rules.

    fn p(start: Date, end: Date) -> DatePeriod {
        DatePeriod { start, end }
    }

    fn history<'a>(contracts: &'a [DatePeriod], leave: &'a [DatePeriod]) -> FixedTermHistory<'a> {
        FixedTermHistory {
            contracts,
            childcare_leave: leave,
            hire_date: date!(2024 - 01 - 01),
        }
    }

    #[test]
    fn period_end_follows_civil_code() {
        assert_eq!(period_end(date!(2024 - 01 - 01), 24), date!(2025 - 12 - 31));
        assert_eq!(period_end(date!(2027 - 03 - 01), 24), date!(2029 - 02 - 28));
        // No 2026-02-29: the period ends on the month's last day.
        assert_eq!(period_end(date!(2024 - 02 - 29), 24), date!(2026 - 02 - 28));
        assert_eq!(period_end(date!(2024 - 11 - 15), 3), date!(2025 - 02 - 14));
    }

    #[test]
    fn two_year_contract_spanning_a_leap_day_is_within() {
        let contracts = [p(date!(2027 - 03 - 01), date!(2028 - 02 - 29))];
        let (verdict, _) = check_renewal(
            history(&contracts, &[]),
            p(date!(2028 - 03 - 01), date!(2029 - 02 - 28)),
            LIMIT,
        );
        assert_eq!(verdict, RenewalVerdict::Within);
    }

    #[test]
    fn twenty_three_months_plus_a_year_exceeds() {
        let contracts = [p(date!(2024 - 01 - 01), date!(2025 - 11 - 30))];
        let (verdict, service) = check_renewal(
            history(&contracts, &[]),
            p(date!(2025 - 12 - 01), date!(2026 - 11 - 30)),
            LIMIT,
        );
        assert_eq!(verdict, RenewalVerdict::ExceedsLimit);
        assert_eq!(service.two_year_date, date!(2025 - 12 - 31));
        assert_eq!(service.basis, ServiceBasis::ContractHistory);
    }

    #[test]
    fn childcare_leave_extends_the_limit() {
        // 23 months with 4 months of 육아휴직 = 19 counted months; a 5-month
        // renewal stays within 24, and exceeds it without the leave.
        let contracts = [p(date!(2024 - 01 - 01), date!(2025 - 11 - 30))];
        let leave = [p(date!(2024 - 06 - 01), date!(2024 - 09 - 30))];
        let renewal = p(date!(2025 - 12 - 01), date!(2026 - 04 - 30));
        let leave_days = (date!(2024 - 09 - 30) - date!(2024 - 06 - 01)).whole_days() + 1;
        let (verdict, service) = check_renewal(history(&contracts, &leave), renewal, LIMIT);
        assert_eq!(
            service.two_year_date,
            date!(2025 - 12 - 31) + Duration::days(leave_days)
        );
        assert_eq!(verdict, RenewalVerdict::Within);
        let (without_leave, _) = check_renewal(history(&contracts, &[]), renewal, LIMIT);
        assert_eq!(without_leave, RenewalVerdict::ExceedsLimit);
    }

    #[test]
    fn gaps_between_contracts_do_not_count() {
        let contracts = [
            p(date!(2024 - 01 - 01), date!(2024 - 12 - 31)),
            p(date!(2025 - 03 - 01), date!(2025 - 12 - 31)),
        ];
        let service = fixed_term_service(history(&contracts, &[]), date!(2025 - 12 - 31), LIMIT);
        assert_eq!(service.cumulative_days, 366 + 306);
        // 59 gap days (2025-01-01..=2025-02-28) push the limit out.
        assert_eq!(
            service.two_year_date,
            date!(2025 - 12 - 31) + Duration::days(59)
        );
    }

    #[test]
    fn cumulative_days_stop_at_as_of_and_skip_leave() {
        let contracts = [p(date!(2025 - 01 - 01), date!(2026 - 12 - 31))];
        let leave = [p(date!(2025 - 01 - 11), date!(2025 - 01 - 20))];
        let service = fixed_term_service(history(&contracts, &leave), date!(2025 - 01 - 31), LIMIT);
        assert_eq!(service.cumulative_days, 21);
    }

    #[test]
    fn no_contract_history_falls_back_to_hire_date_and_only_flags() {
        let service = fixed_term_service(history(&[], &[]), date!(2025 - 12 - 31), LIMIT);
        assert_eq!(service.basis, ServiceBasis::HireDateFallback);
        assert_eq!(service.cumulative_days, 731);
        assert_eq!(service.two_year_date, date!(2025 - 12 - 31));
        let (verdict, _) = check_renewal(
            history(&[], &[]),
            p(date!(2026 - 01 - 01), date!(2026 - 12 - 31)),
            LIMIT,
        );
        assert_eq!(verdict, RenewalVerdict::ExceedsUnverified);
        let (verdict, _) = check_renewal(
            history(&[], &[]),
            p(date!(2025 - 01 - 01), date!(2025 - 12 - 31)),
            LIMIT,
        );
        assert_eq!(verdict, RenewalVerdict::Within);
    }
}
