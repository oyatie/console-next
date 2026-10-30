// SPDX-License-Identifier: LicenseRef-Proprietary
//! Consequential pay-group choices; none has a default.
use console_kernel_core::KernelError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PayDay {
    Day(u8),
    LastDay,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeriodStart {
    Day(u8),
    First,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NonBusinessDay {
    Previous,
    Next,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProrationBasis {
    CalendarDays,
    ScheduledWorkdays,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaymentChannel {
    AttestationOnly,
    FileGeneric,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PayDateRule {
    pub day: PayDay,
    pub month_offset: u8,
    pub non_business_day: NonBusinessDay,
}
impl PayDateRule {
    pub fn validate(self) -> Result<(), KernelError> {
        if matches!(self.day, PayDay::Day(day) if !(1..=31).contains(&day)) || self.month_offset > 1
        {
            return Err(KernelError::validation(
                "pay date requires day 1–31 or LAST_DAY and month offset 0–1",
            )
            .with_field("pay_date_rule"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeriodRule {
    pub start_day: PeriodStart,
    pub month_offset: i8,
}
impl PeriodRule {
    pub fn validate(self, field: &str) -> Result<(), KernelError> {
        if matches!(self.start_day, PeriodStart::Day(day) if !(1..=28).contains(&day))
            || !(-1..=0).contains(&self.month_offset)
        {
            return Err(KernelError::validation(
                "pay period requires start day 1–28 or FIRST and month offset -1–0",
            )
            .with_field(field));
        }
        Ok(())
    }
}
