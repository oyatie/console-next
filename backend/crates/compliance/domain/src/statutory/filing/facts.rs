use super::{Treaty, VisaCoverage};
use console_kernel_core::KernelError;
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PensionDailySector {
    General,
    ConstructionNotice,
    Unverified,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FilingFacts {
    pub birth_date: Option<String>,
    pub monthly_hours: Option<u16>,
    pub weekly_hours: Option<u16>,
    pub continuous_months: Option<u16>,
    pub daily: Option<bool>,
    pub work_days: Option<u16>,
    pub worked_monthly_hours: Option<u16>,
    pub pension_opt_in: Option<bool>,
    pub pension_lecturer_covered: Option<bool>,
    pub pension_daily_sector: Option<PensionDailySector>,
    pub minor_opt_out: Option<bool>,
    pub multiple_jobs_covered: Option<bool>,
    pub income_exception_covered: Option<bool>,
    pub monthly_income_won: Option<i64>,
    pub foreign: Option<bool>,
    pub treaty: Option<Treaty>,
    pub visa: Option<VisaCoverage>,
    pub director_without_worker_status: Option<bool>,
}
impl FilingFacts {
    pub fn validate(&self) -> Result<(), KernelError> {
        if self
            .birth_date
            .as_deref()
            .map(super::super::parse_date)
            .transpose()
            .is_err()
            || self.monthly_hours.is_some_and(|h| h > 24 * 31)
            || self.weekly_hours.is_some_and(|h| h > 24 * 7)
            || self.work_days.is_some_and(|n| n > 31)
            || self.worked_monthly_hours.is_some_and(|h| h > 24 * 31)
            || self.monthly_income_won.is_some_and(|n| n < 0)
        {
            return Err(KernelError::validation(
                "invalid filing applicability facts",
            ));
        }
        Ok(())
    }
}
