//! Effective-dated filing rules: the whole clock and applicability belong to the register.
mod applicability;
mod coverage;
#[cfg(test)]
mod coverage_tests;
mod dates;
mod facts;
#[cfg(test)]
mod validation_tests;
pub use facts::PensionDailySector;
pub mod resolution;
#[cfg(test)]
mod tests;
mod work_coverage;
pub use applicability::{
    Applicability, Exclusion, FilingFacts, Reason, Treaty, VisaCoverage, applicability, applies,
};
use console_kernel_core::KernelError;
pub use dates::{FilingDates, dates};
use serde::{Deserialize, Serialize};
use time::Date;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FilingAnchor {
    AcquireDate,
    LossDate,
    ExitDate,
    RequestDate,
    WorkMonth,
    EffectiveDate,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FilingRuleKind {
    Days,
    DayOfNextMonth,
    WithoutDelay,
    Unknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FirstDay {
    Included,
    Excluded,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum HolidayRoll {
    Unverified,
    CivilCode161,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Calculation {
    pub anchor: FilingAnchor,
    pub kind: FilingRuleKind,
    pub value: Option<u16>,
    pub first_day: FirstDay,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FilingCitation {
    pub instrument: String,
    pub article: String,
    pub promulgation: String,
    pub source_url: String,
    pub enforced_on: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Penalty {
    pub citation: FilingCitation,
    pub delay_won: Vec<u32>,
    pub per_worker: bool,
    pub cap_won: Option<u32>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FilingRule {
    pub code: String,
    #[serde(default)]
    pub trigger_event_kinds: Vec<String>,
    pub insurer: String,
    pub filing_kind: String,
    pub effective_from: String,
    pub effective_to_exclusive: Option<String>,
    pub deadline: Calculation,
    pub candidate: Option<Calculation>,
    pub opens_anchor: FilingAnchor,
    pub opens_offset: i16,
    pub holiday_roll: HolidayRoll,
    pub open: bool,
    pub citation: FilingCitation,
    pub exclusions: Vec<Exclusion>,
    pub penalty: Option<Penalty>,
    pub covered_by: Option<String>,
    pub age_trigger_years: Option<u16>,
    #[serde(default)]
    pub remuneration_required: bool,
    #[serde(default)]
    pub daily_required: bool,
    #[serde(default)]
    pub applicability_unverified: bool,
    #[serde(default)]
    pub applicability_anchor: Option<FilingAnchor>,
    #[serde(default)]
    pub applicability_citations: Vec<FilingCitation>,
    #[serde(default)]
    pub age_limit_anchor: Option<FilingAnchor>,
    #[serde(default)]
    pub age_limit_offset: i16,
    #[serde(default)]
    pub loss_offset_days: i16,
}
impl FilingRule {
    pub fn loss_on(&self, exit: Date) -> Result<Date, KernelError> {
        exit.checked_add(time::Duration::days(self.loss_offset_days.into()))
            .ok_or_else(|| KernelError::validation("loss date outside calendar"))
    }
    pub fn in_force(&self, on: Date) -> Result<bool, KernelError> {
        let parse = |s: &str| super::parse_date(s);
        Ok(on >= parse(&self.effective_from)?
            && self
                .effective_to_exclusive
                .as_deref()
                .map(parse)
                .transpose()?
                .is_none_or(|end| on < end))
    }
    pub fn validate(&self) -> Result<(), KernelError> {
        let from = super::parse_date(&self.effective_from)?;
        if self
            .effective_to_exclusive
            .as_deref()
            .map(super::parse_date)
            .transpose()?
            .is_some_and(|end| end <= from)
            || super::parse_date(&self.citation.enforced_on)? > from
            || !self
                .citation
                .source_url
                .starts_with("https://www.law.go.kr/")
        {
            return Err(KernelError::validation(
                "invalid filing rule period or citation",
            ));
        }
        for c in std::iter::once(&self.deadline).chain(self.candidate.iter()) {
            match (c.kind, c.value) {
                (FilingRuleKind::Days, Some(n)) if n > 0 => (),
                (FilingRuleKind::DayOfNextMonth, Some(n)) if (1..=28).contains(&n) => (),
                (FilingRuleKind::WithoutDelay | FilingRuleKind::Unknown, None) => (),
                _ => return Err(KernelError::validation("invalid filing calculation")),
            }
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Default)]
pub struct FilingAnchors {
    pub effective_date: Option<Date>,
    pub acquire_date: Option<Date>,
    pub exit_date: Option<Date>,
    pub loss_date: Option<Date>,
    pub request_date: Option<Date>,
    pub work_month: Option<Date>,
}
impl FilingAnchors {
    pub fn get(&self, a: FilingAnchor) -> Option<Date> {
        match a {
            FilingAnchor::AcquireDate => self.acquire_date,
            FilingAnchor::LossDate => self.loss_date,
            FilingAnchor::ExitDate => self.exit_date,
            FilingAnchor::RequestDate => self.request_date,
            FilingAnchor::WorkMonth => self.work_month,
            FilingAnchor::EffectiveDate => self.effective_date,
        }
    }
}
