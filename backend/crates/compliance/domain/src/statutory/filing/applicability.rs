pub use super::coverage::applies;
pub use super::facts::FilingFacts;
use console_kernel_core::KernelError;
use serde::{Deserialize, Serialize};
use time::Date;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Reason {
    AgeLimit,
    MinorOptOut,
    ShortHours,
    DailyUnderMonth,
    DailyWorkConfirmation,
    TreatyExcluded,
    VisaExcluded,
    ExecutiveNotWorker,
    OtherLegalGround,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Treaty {
    Covered,
    Excluded,
    Unverified,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum VisaCoverage {
    Mandatory,
    OptedIn,
    OptionalNotOptedIn,
    Excluded,
    Unverified,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE", deny_unknown_fields)]
pub enum Exclusion {
    AgeLimit {
        years: u16,
    },
    MinorOptOut {
        years: u16,
    },
    ShortHours {
        monthly: u16,
        weekly: Option<u16>,
        continuous_months_exception: Option<u16>,
        pension_exceptions: bool,
        daily_exception: bool,
    },
    Daily {
        minimum_months: u16,
        days_exception: Option<u16>,
        hours_exception: Option<u16>,
        income_exception: bool,
        work_confirmation: bool,
    },
    ForeignTreaty,
    ForeignVisa,
    ExecutiveNotWorker,
    Income {
        threshold_won: Option<i64>,
        continuous_months_exception: u16,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Applicability {
    Applies,
    NotApplicable { reason: Reason },
    Unknown { missing: Vec<&'static str> },
}

pub fn applicability(
    rules: &[Exclusion],
    facts: &FilingFacts,
    on: Date,
) -> Result<Applicability, KernelError> {
    facts.validate()?;
    let mut missing = Vec::new();
    for rule in rules {
        let (reason, verdict) = match rule {
            Exclusion::AgeLimit { years } | Exclusion::MinorOptOut { years } => {
                let reason = if matches!(rule, Exclusion::AgeLimit { .. }) {
                    Reason::AgeLimit
                } else {
                    Reason::MinorOptOut
                };
                let attained = facts
                    .birth_date
                    .as_deref()
                    .map(super::super::parse_date)
                    .transpose()?
                    .map(|birth| {
                        let year = birth
                            .year()
                            .checked_add(i32::from(*years))
                            .ok_or_else(|| KernelError::validation("age outside calendar"))?;
                        let anniversary = Date::from_calendar_date(
                            year,
                            birth.month(),
                            birth.day().min(birth.month().length(year)),
                        )
                        .map_err(|_| KernelError::validation("age outside calendar"))?;
                        Ok::<_, KernelError>(on >= anniversary)
                    })
                    .transpose()?;
                (
                    reason,
                    match attained {
                        Some(attained) if reason == Reason::AgeLimit => Some(attained),
                        Some(true) => Some(false),
                        Some(_) => {
                            if facts.minor_opt_out.is_none() {
                                missing.push("minor_opt_out");
                            }
                            facts.minor_opt_out
                        }
                        None => {
                            missing.push("birth_date");
                            None
                        }
                    },
                )
            }
            rule @ (Exclusion::ShortHours { .. }
            | Exclusion::Daily { .. }
            | Exclusion::Income { .. }) => {
                super::work_coverage::evaluate(rule, facts, &mut missing)
            }
            Exclusion::ForeignTreaty => (
                Reason::TreatyExcluded,
                match facts.foreign {
                    Some(false) => Some(false),
                    Some(true) => match facts.treaty {
                        Some(Treaty::Covered) => Some(false),
                        Some(Treaty::Excluded) => Some(true),
                        _ => {
                            missing.push("treaty");
                            None
                        }
                    },
                    None => {
                        missing.push("nationality");
                        None
                    }
                },
            ),
            Exclusion::ForeignVisa => (
                Reason::VisaExcluded,
                match facts.foreign {
                    Some(false) => Some(false),
                    Some(true) => match facts.visa {
                        Some(VisaCoverage::Mandatory | VisaCoverage::OptedIn) => Some(false),
                        Some(VisaCoverage::OptionalNotOptedIn | VisaCoverage::Excluded) => {
                            Some(true)
                        }
                        _ => {
                            missing.push("visa");
                            None
                        }
                    },
                    None => {
                        missing.push("nationality");
                        None
                    }
                },
            ),
            Exclusion::ExecutiveNotWorker => {
                if facts.director_without_worker_status.is_none() {
                    missing.push("director_without_worker_status");
                }
                (
                    Reason::ExecutiveNotWorker,
                    facts.director_without_worker_status,
                )
            }
        };
        if verdict == Some(true) {
            return Ok(Applicability::NotApplicable { reason });
        }
    }
    missing.sort_unstable();
    missing.dedup();
    Ok(if missing.is_empty() {
        Applicability::Applies
    } else {
        Applicability::Unknown { missing }
    })
}
