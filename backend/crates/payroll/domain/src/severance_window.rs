//! BW-09: the average-wage window, its countable days, and the one-year
//! severance test, derived from dates instead of typed by hand.
//!
//! Date model (decisions 0.1): `exit_date` is the last working day (이직일) and
//! `loss_date = exit_date + 1` (상실일; 퇴직일 in 근로기준법/퇴직급여 practice).
//! Pure date math only: no IO, no clock, no policy values.

use console_kernel_core::KernelError;
use time::{Date, Month};

mod exclusion;
pub use exclusion::{ExclusionPeriod, ExclusionReason};

/// The derived 평균임금 산정기간. `start..=end`, both inclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AverageWageWindow {
    pub start: Date,
    pub end: Date,
    pub calendar_days: i64,
    /// Days of the window covered by at least one exclusion (overlaps counted once).
    pub excluded_days: i64,
    /// `calendar_days - excluded_days`: the divisor for the average daily wage.
    pub countable_days: i64,
}

impl AverageWageWindow {
    /// True when `day` falls in the window. An admitted retro event dated
    /// inside it invalidates an open settlement (BW-09, decisions BW-09).
    #[must_use]
    pub fn contains(&self, day: Date) -> bool {
        (self.start..=self.end).contains(&day)
    }
}

/// `exit_date + 1`.
pub fn loss_date(exit_date: Date) -> Result<Date, KernelError> {
    exit_date
        .next_day()
        .ok_or_else(|| KernelError::validation("exit date is out of range"))
}

/// The 3 calendar months before `loss_date`, ending on `exit_date` inclusive
/// (근로기준법 §2①6: 「사유가 발생한 날 이전 3개월」). Last working day 9/30 →
/// 7/1–9/30.
/// Each exclusion first shrinks to what 시행령 §2① removes
/// ([`ExclusionReason`]), then is clipped to the window.
/// A window with no countable day is refused: 판례 then moves the window to
/// before the exclusion, which needs wage history this function does not have.
pub fn average_wage_window(
    exit_date: Date,
    exclusions: &[ExclusionPeriod],
) -> Result<AverageWageWindow, KernelError> {
    let start = months_before(loss_date(exit_date)?, 3)?;
    let end = exit_date;

    let mut clipped = Vec::with_capacity(exclusions.len());
    for period in exclusions {
        let Some((from, to)) = period.statutory_span()? else {
            continue;
        };
        let from = from.max(start);
        let to = to.min(end);
        if from <= to {
            clipped.push((from, to));
        }
    }
    clipped.sort_unstable();

    let mut excluded_days = 0;
    let mut covered_through: Option<Date> = None;
    for (from, to) in clipped {
        let from = match covered_through {
            Some(last) if from <= last => match last.next_day() {
                Some(next) if next <= to => next,
                _ => continue,
            },
            _ => from,
        };
        excluded_days += inclusive_days(from, to);
        covered_through = Some(to);
    }

    let calendar_days = inclusive_days(start, end);
    let countable_days = calendar_days - excluded_days;
    if countable_days <= 0 {
        return Err(KernelError::validation(
            "the whole average wage window is excluded; set the window by review",
        ));
    }
    Ok(AverageWageWindow {
        start,
        end,
        calendar_days,
        excluded_days,
        countable_days,
    })
}

/// 퇴직금 service condition of 근로자퇴직급여 보장법 §4①: one calendar year,
/// i.e. `loss_date >= hire_date + 1 year`. Not `>= 365 days`, which is a day
/// short across a 2/29. A 2/29 hire reaches the anniversary on 3/1
/// (민법 §160③: the period ends on 2/28).
///
/// The 15 h/week condition is separate and not decided here.
pub fn completes_one_year_of_service(
    hire_date: Date,
    exit_date: Date,
) -> Result<bool, KernelError> {
    if exit_date < hire_date {
        return Err(KernelError::validation(
            "exit date must be on or after hire date",
        ));
    }
    let anniversary =
        same_day_or_next_month_start(hire_date.year() + 1, hire_date.month(), hire_date.day())?;
    Ok(loss_date(exit_date)? >= anniversary)
}

/// The same day of the month `months` earlier. A day the target month lacks
/// (5/31 → 2/31) becomes the 1st of the following month (3/1), mirroring
/// 민법 §160③. [U] 노무사 to confirm the month-end case.
fn months_before(day: Date, months: i32) -> Result<Date, KernelError> {
    let index = day.year() * 12 + i32::from(u8::from(day.month())) - 1 - months;
    let month = u8::try_from(index.rem_euclid(12) + 1)
        .ok()
        .and_then(|m| Month::try_from(m).ok())
        .ok_or_else(|| KernelError::validation("month arithmetic out of range"))?;
    same_day_or_next_month_start(index.div_euclid(12), month, day.day())
}

fn same_day_or_next_month_start(year: i32, month: Month, day: u8) -> Result<Date, KernelError> {
    Date::from_calendar_date(year, month, day)
        .ok()
        .or_else(|| {
            Date::from_calendar_date(year, month, month.length(year))
                .ok()?
                .next_day()
        })
        .ok_or_else(|| KernelError::validation("date is out of range"))
}

fn inclusive_days(from: Date, to: Date) -> i64 {
    i64::from(to.to_julian_day() - from.to_julian_day()) + 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;

    fn window(exit: Date, exclusions: &[ExclusionPeriod]) -> AverageWageWindow {
        average_wage_window(exit, exclusions).unwrap()
    }

    fn excl(from: Date, to: Date) -> ExclusionPeriod {
        ExclusionPeriod {
            from,
            to,
            reason: ExclusionReason::ChildcareLeave,
        }
    }

    #[test]
    fn month_end_exit_window_is_the_three_whole_months() {
        let w = window(date!(2026 - 09 - 30), &[]);
        assert_eq!(
            (w.start, w.end),
            (date!(2026 - 07 - 01), date!(2026 - 09 - 30))
        );
        assert_eq!(
            (w.calendar_days, w.excluded_days, w.countable_days),
            (92, 0, 92)
        );
    }

    #[test]
    fn mid_month_exit_window_starts_three_months_before_loss_date() {
        let w = window(date!(2026 - 03 - 14), &[]);
        assert_eq!(
            (w.start, w.end),
            (date!(2025 - 12 - 15), date!(2026 - 03 - 14))
        );
        assert_eq!(w.calendar_days, 90);
    }

    #[test]
    fn missing_corresponding_day_rolls_to_next_month_start() {
        // loss 5/31 → 2/31 does not exist → 3/1.
        let w = window(date!(2026 - 05 - 30), &[]);
        assert_eq!(w.start, date!(2026 - 03 - 01));
        assert_eq!(w.calendar_days, 91);
        // Leap year: loss 5/30 → 2/30 → 3/1; loss 5/29 → 2/29 exists.
        assert_eq!(
            window(date!(2028 - 05 - 29), &[]).start,
            date!(2028 - 03 - 01)
        );
        assert_eq!(
            window(date!(2028 - 05 - 28), &[]).start,
            date!(2028 - 02 - 29)
        );
    }

    #[test]
    fn year_boundary_window() {
        let w = window(date!(2027 - 01 - 31), &[]);
        assert_eq!(
            (w.start, w.end),
            (date!(2026 - 11 - 01), date!(2027 - 01 - 31))
        );
    }

    #[test]
    fn exclusions_are_clipped_merged_and_subtracted() {
        let w = window(
            date!(2026 - 09 - 30),
            &[
                // Starts before the window: clipped to 7/1..7/10 = 10 days.
                excl(date!(2026 - 06 - 01), date!(2026 - 07 - 10)),
                // Overlaps the previous one: only 7/11..7/15 is new = 5 days.
                excl(date!(2026 - 07 - 05), date!(2026 - 07 - 15)),
                // Fully inside an earlier span: adds nothing.
                excl(date!(2026 - 07 - 02), date!(2026 - 07 - 03)),
                // Ends after the window: clipped to 9/29..9/30 = 2 days.
                excl(date!(2026 - 09 - 29), date!(2026 - 10 - 20)),
                // Outside the window: 0 days.
                excl(date!(2026 - 01 - 01), date!(2026 - 01 - 31)),
            ],
        );
        assert_eq!((w.excluded_days, w.countable_days), (17, 75));
    }

    #[test]
    fn adjacent_exclusions_do_not_double_count() {
        let w = window(
            date!(2026 - 09 - 30),
            &[
                excl(date!(2026 - 08 - 01), date!(2026 - 08 - 10)),
                excl(date!(2026 - 08 - 10), date!(2026 - 08 - 20)),
            ],
        );
        assert_eq!(w.excluded_days, 20);
    }

    #[test]
    fn inverted_exclusion_is_refused() {
        let err = average_wage_window(
            date!(2026 - 09 - 30),
            &[excl(date!(2026 - 08 - 10), date!(2026 - 08 - 01))],
        )
        .unwrap_err();
        assert_eq!(err.kind, console_kernel_core::ErrorKind::Validation);
    }

    #[test]
    fn fully_excluded_window_is_refused() {
        let err = average_wage_window(
            date!(2026 - 09 - 30),
            &[excl(date!(2026 - 01 - 01), date!(2026 - 12 - 31))],
        )
        .unwrap_err();
        assert_eq!(err.kind, console_kernel_core::ErrorKind::Validation);
    }

    #[test]
    fn window_contains_its_ends_only() {
        let w = window(date!(2026 - 09 - 30), &[]);
        assert!(w.contains(date!(2026 - 07 - 01)));
        assert!(w.contains(date!(2026 - 09 - 30)));
        assert!(!w.contains(date!(2026 - 06 - 30)));
        assert!(!w.contains(date!(2026 - 10 - 01)));
    }

    #[test]
    fn one_year_is_a_calendar_year_not_365_days() {
        let yes = |h, e| completes_one_year_of_service(h, e).unwrap();
        assert!(yes(date!(2025 - 03 - 01), date!(2026 - 02 - 28)));
        assert!(!yes(date!(2025 - 03 - 01), date!(2026 - 02 - 27)));
        // Across 2/29: 365 days of service is still a day short.
        assert!(!yes(date!(2023 - 03 - 01), date!(2024 - 02 - 28)));
        assert!(yes(date!(2023 - 03 - 01), date!(2024 - 02 - 29)));
        // A 2/29 hire completes the year on 2/28.
        assert!(yes(date!(2024 - 02 - 29), date!(2025 - 02 - 28)));
        assert!(!yes(date!(2024 - 02 - 29), date!(2025 - 02 - 27)));
        // 200 days of service.
        assert!(!yes(date!(2026 - 01 - 01), date!(2026 - 07 - 19)));
    }

    #[test]
    fn exit_before_hire_is_refused() {
        assert!(
            completes_one_year_of_service(date!(2026 - 02 - 01), date!(2026 - 01 - 31)).is_err()
        );
    }
}
