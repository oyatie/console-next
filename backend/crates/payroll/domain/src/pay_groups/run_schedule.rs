// SPDX-License-Identifier: LicenseRef-Proprietary
//! One calendar derivation for previews and persisted run snapshots.
use console_kernel_core::KernelError;
use time::{Date, Duration, Month};

use crate::pay_groups::{NonBusinessDay, PayDateRule, PayDay, PeriodRule, PeriodStart};

#[derive(Debug, PartialEq, Eq)]
pub struct RunSchedule {
    pub pay_date: Date,
    pub pay_date_clamped: bool,
    pub base_start: Date,
    pub base_end: Date,
    pub variable_start: Date,
    pub variable_end: Date,
}

fn shift_month(month: Date, offset: i8) -> Result<Date, KernelError> {
    let index = month.year() * 12 + i32::from(month.month() as u8) - 1 + i32::from(offset);
    let next = Month::try_from((index.rem_euclid(12) + 1) as u8).map_err(calendar_error)?;
    Date::from_calendar_date(index.div_euclid(12), next, 1).map_err(calendar_error)
}

fn calendar_error(_: impl std::fmt::Display) -> KernelError {
    KernelError::validation("run schedule is outside the supported calendar")
}

fn period(month: Date, rule: PeriodRule) -> Result<(Date, Date), KernelError> {
    let day = match rule.start_day {
        PeriodStart::First => 1,
        PeriodStart::Day(day) => day,
    };
    let start_month = shift_month(month, rule.month_offset)?;
    let start = start_month.replace_day(day).map_err(calendar_error)?;
    let end = shift_month(start_month, 1)?
        .replace_day(day)
        .map_err(calendar_error)?
        .previous_day()
        .ok_or_else(|| calendar_error("period end"))?;
    Ok((start, end))
}

pub fn derive_schedule(
    month: Date,
    pay: PayDateRule,
    base: PeriodRule,
    variable: PeriodRule,
    mut is_business_day: impl FnMut(Date) -> Result<bool, KernelError>,
) -> Result<RunSchedule, KernelError> {
    if month.day() != 1 {
        return Err(KernelError::validation(
            "attribution month must start on day one",
        ));
    }
    pay.validate()?;
    base.validate("base_period")?;
    variable.validate("variable_period")?;
    let pay_month = shift_month(month, pay.month_offset as i8)?;
    let last = shift_month(pay_month, 1)?
        .previous_day()
        .ok_or_else(|| calendar_error("month end"))?;
    let requested = match pay.day {
        PayDay::LastDay => last.day(),
        PayDay::Day(day) => day,
    };
    let mut pay_date = pay_month
        .replace_day(requested.min(last.day()))
        .map_err(calendar_error)?;
    while !is_business_day(pay_date)? {
        let step = match pay.non_business_day {
            NonBusinessDay::Previous => -1,
            NonBusinessDay::Next => 1,
        };
        pay_date = pay_date
            .checked_add(Duration::days(step))
            .ok_or_else(|| calendar_error("pay date"))?;
    }
    let (base_start, base_end) = period(month, base)?;
    let (variable_start, variable_end) = period(month, variable)?;
    Ok(RunSchedule {
        pay_date,
        pay_date_clamped: requested > last.day(),
        base_start,
        base_end,
        variable_start,
        variable_end,
    })
}
