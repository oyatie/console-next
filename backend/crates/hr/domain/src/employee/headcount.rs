//! BW-35: the derived 사업장 fact 「상시근로자 수 N인 이상」 (decisions #3,
//! exits-challenge A3), by 근로기준법 시행령 §7의2 ①②④.
//!
//! Derived, never set: no default and no tenant toggle. Overriding it is the
//! governed exception `HEADCOUNT_CLASS_OVERRIDE`, applied by the caller.
//! Every statutory number arrives in [`HeadcountRules`], loaded by the caller
//! from the `statutory_rules` register (HOLD rows until a 노무사 lifts them).
//!
//! Not encoded here (callers own them until ST-1 / the 노무사 confirm):
//! - §7의2③ (§60–62 except §60②: five or more in every month of the prior
//!   year) needs month-by-month results; compose it from this function.
//! - §7의2④ 파견근로자 are excluded by the caller: they are not on the roster.
//! - Whether 「일별로」 in ② counts every calendar day or only 가동일 [U]: this
//!   counts 가동일, the same days ① divides by.

use console_kernel_core::KernelError;
use time::{Date, Month};

/// Statutory numbers for the §7의2 method, one field per register row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HeadcountRules {
    /// §7의2② 「법 적용 기준」: 5, or 10 when judging 근기법 §93.
    pub threshold: u32,
    /// §7의2① 산정기간: months before the 법 적용 사유 발생일.
    pub lookback_months: u8,
}

/// One worker's employment at this 사업장, both ends inclusive. `last_day` is
/// the last working day (`exit_date`, decisions 0.1); `None` while employed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RosterSpan {
    pub first_day: Date,
    pub last_day: Option<Date>,
    /// §7의2④2: a 동거하는 친족 counts only on a day at least one other
    /// worker is employed.
    pub cohabiting_relative: bool,
}

impl RosterSpan {
    fn employed_on(&self, day: Date) -> bool {
        self.first_day <= day && self.last_day.is_none_or(|last| day <= last)
    }
}

/// The derivation, kept whole so the dismissal card can say why.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HeadcountClass {
    /// 산정기간, both ends inclusive.
    pub period_start: Date,
    pub period_end: Date,
    /// 가동 일수: the divisor of ①.
    pub operating_days: u32,
    /// 연인원: the dividend of ①. The average is `person_days / operating_days`.
    pub person_days: u64,
    /// ① alone: the average reaches the threshold.
    pub average_meets_threshold: bool,
    /// ②: 가동일 whose count is below the threshold.
    pub days_below_threshold: u32,
    /// The fact: ②1 and ②2 together reduce to 「days below < half」.
    pub meets_threshold: bool,
}

/// 산정기간 for an event on `event_date`: `lookback_months` before it through
/// the day before, starting no earlier than `established` (①, 「사업이 성립한
/// 날부터 1개월 미만인 경우」). A day the start month lacks (3/31 → 2/31)
/// becomes the 1st of the following month (3/1), as BW-09 does [U].
///
/// # Errors
/// Validation when the business is established on or after `event_date` (the
/// period would be empty) or the date leaves the supported range.
pub fn computation_period(
    event_date: Date,
    established: Date,
    rules: &HeadcountRules,
) -> Result<(Date, Date), KernelError> {
    if established >= event_date {
        return Err(KernelError::validation(
            "headcount period is empty: the business is established on or after the event date",
        ));
    }
    let end = event_date.previous_day().ok_or_else(out_of_range)?;
    let start = months_before(event_date, rules.lookback_months)?.max(established);
    Ok((start, end))
}

/// Derives the headcount class of ONE 사업장 for an event on `event_date`.
/// `operating_days` are the 가동일 the caller's calendar reports for the
/// period; `roster` is every worker of this 사업장 whose span touches it.
///
/// # Errors
/// Validation when the period is empty, an operating day falls outside it or
/// repeats, a span ends before it starts, or no day operated. Never a
/// fallback class.
pub fn headcount_class(
    event_date: Date,
    established: Date,
    operating_days: &[Date],
    roster: &[RosterSpan],
    rules: &HeadcountRules,
) -> Result<HeadcountClass, KernelError> {
    let (period_start, period_end) = computation_period(event_date, established, rules)?;
    if roster
        .iter()
        .any(|span| span.last_day.is_some_and(|last| last < span.first_day))
    {
        return Err(KernelError::validation(
            "roster span must end on or after its first day",
        ));
    }
    let mut days = operating_days.to_vec();
    days.sort_unstable();
    if days.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(KernelError::validation("operating days must not repeat"));
    }
    if days
        .iter()
        .any(|day| !(period_start..=period_end).contains(day))
    {
        return Err(KernelError::validation(
            "operating day falls outside the headcount period",
        ));
    }
    if days.is_empty() {
        return Err(KernelError::validation(
            "headcount period has no operating day",
        ));
    }

    let threshold = u64::from(rules.threshold);
    let mut person_days = 0_u64;
    let mut days_below_threshold = 0_u32;
    for &day in &days {
        let count = workers_on(day, roster);
        person_days += count;
        if count < threshold {
            days_below_threshold += 1;
        }
    }
    let operating_days = u32::try_from(days.len()).map_err(|_| out_of_range())?;
    Ok(HeadcountClass {
        period_start,
        period_end,
        operating_days,
        person_days,
        average_meets_threshold: person_days >= threshold * u64::from(operating_days),
        days_below_threshold,
        meets_threshold: u64::from(days_below_threshold) * 2 < u64::from(operating_days),
    })
}

/// §7의2④: everyone employed that day, relatives only alongside another worker.
fn workers_on(day: Date, roster: &[RosterSpan]) -> u64 {
    let employed = || roster.iter().filter(move |span| span.employed_on(day));
    if employed().all(|span| span.cohabiting_relative) {
        0
    } else {
        employed().count() as u64
    }
}

// copy of payroll-domain severance_window::months_before (N10); hr
// cannot depend on payroll. Hoist to kernel if a third caller appears.
fn months_before(day: Date, months: u8) -> Result<Date, KernelError> {
    let index = day.year() * 12 + i32::from(u8::from(day.month())) - 1 - i32::from(months);
    let month = u8::try_from(index.rem_euclid(12) + 1)
        .ok()
        .and_then(|m| Month::try_from(m).ok())
        .ok_or_else(out_of_range)?;
    let year = index.div_euclid(12);
    // Only Feb–Nov can lack a day, so `month.next()` stays in `year`.
    Date::from_calendar_date(year, month, day.day())
        .or_else(|_| Date::from_calendar_date(year, month.next(), 1))
        .map_err(|_| out_of_range())
}

fn out_of_range() -> KernelError {
    KernelError::validation("headcount date is outside the supported calendar range")
}
