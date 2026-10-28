use super::{Calculation, FilingAnchors, FilingRule, FilingRuleKind, FirstDay, HolidayRoll};
use console_kernel_core::KernelError;
use serde::Serialize;
use time::{Date, Duration, Month, Weekday};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FilingDates {
    pub opens_on: String,
    pub target_on: String,
    pub due_on: Option<String>,
    pub legal_latest_candidate: Option<String>,
    pub conservative: bool,
    pub without_delay: bool,
    pub holiday_roll_unverified: bool,
}
pub fn dates(
    rule: &FilingRule,
    anchors: &FilingAnchors,
    holidays: &[Date],
) -> Result<FilingDates, KernelError> {
    rule.validate()?;
    let opens = anchors
        .get(rule.opens_anchor)
        .and_then(|d| d.checked_add(Duration::days(rule.opens_offset.into())))
        .ok_or_else(|| {
            KernelError::validation("filing opening anchor missing or outside calendar")
        })?;
    let calculate = |c: &Calculation| calculation_date(c, anchors, rule.holiday_roll, holidays);
    let due = calculate(&rule.deadline)?;
    let candidate = rule
        .candidate
        .as_ref()
        .map(calculate)
        .transpose()?
        .flatten();
    Ok(FilingDates {
        opens_on: opens.to_string(),
        target_on: opens.to_string(),
        due_on: due.map(|d| d.to_string()),
        legal_latest_candidate: candidate.map(|d| d.to_string()),
        conservative: rule.candidate.is_some(),
        without_delay: rule.deadline.kind == FilingRuleKind::WithoutDelay,
        holiday_roll_unverified: rule.holiday_roll == HolidayRoll::Unverified,
    })
}
/// Calculate a register clock without insurance-specific filing metadata.
pub fn calculation_date(
    c: &Calculation,
    anchors: &FilingAnchors,
    holiday_roll: HolidayRoll,
    holidays: &[Date],
) -> Result<Option<Date>, KernelError> {
    c.validate()?;
    let on = anchors
        .get(c.anchor)
        .ok_or_else(|| KernelError::validation("filing deadline anchor missing"))?;
    nominal(c, on)?
        .map(|d| roll(d, holiday_roll, holidays))
        .transpose()
}
fn nominal(c: &Calculation, on: Date) -> Result<Option<Date>, KernelError> {
    let out_of_range = || KernelError::validation("filing deadline outside calendar");
    Ok(match c.kind {
        FilingRuleKind::Unknown | FilingRuleKind::WithoutDelay => None,
        FilingRuleKind::Days => Some(
            on.checked_add(Duration::days(
                i64::from(c.value.ok_or_else(out_of_range)?)
                    - i64::from(c.first_day == FirstDay::Included),
            ))
            .ok_or_else(out_of_range)?,
        ),
        FilingRuleKind::DayOfNextMonth => {
            let (year, month) = if on.month() == Month::December {
                (
                    on.year().checked_add(1).ok_or_else(out_of_range)?,
                    Month::January,
                )
            } else {
                (on.year(), on.month().next())
            };
            Some(
                Date::from_calendar_date(
                    year,
                    month,
                    u8::try_from(c.value.ok_or_else(out_of_range)?).map_err(|_| out_of_range())?,
                )
                .map_err(|_| out_of_range())?,
            )
        }
    })
}
fn roll(mut on: Date, rule: HolidayRoll, holidays: &[Date]) -> Result<Date, KernelError> {
    if rule == HolidayRoll::CivilCode161 {
        while matches!(on.weekday(), Weekday::Saturday | Weekday::Sunday) || holidays.contains(&on)
        {
            on = on
                .next_day()
                .ok_or_else(|| KernelError::validation("holiday roll outside calendar"))?;
        }
    }
    Ok(on)
}
