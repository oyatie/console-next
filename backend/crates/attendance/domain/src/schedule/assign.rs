//! Whether a layer may be assigned or cancelled. The caller loads the facts
//! (today in KST, the pattern's state, closed months) and passes them in.

use serde::{Deserialize, Serialize};
use time::{Date, Duration};

use super::ScheduleRefusal;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LayerReason {
    Standard,
    /// 단축 · 시각 변경 on a document (육아기 단축, 임신기 단축, …).
    Reduction,
    /// 대신 근무: one day, one person.
    Substitute,
    Temporary,
}

impl LayerReason {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "STANDARD",
            Self::Reduction => "REDUCTION",
            Self::Substitute => "SUBSTITUTE",
            Self::Temporary => "TEMPORARY",
        }
    }

    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        [
            Self::Standard,
            Self::Reduction,
            Self::Substitute,
            Self::Temporary,
        ]
        .into_iter()
        .find(|r| r.as_str() == raw)
    }
}

/// `(year, month)` of a date.
#[must_use]
pub fn month_of(date: Date) -> (i32, u8) {
    (date.year(), u8::from(date.month()))
}

#[derive(Debug, Clone)]
pub struct AssignRules<'a> {
    pub effective_from: Date,
    pub effective_to: Option<Date>,
    pub reason: LayerReason,
    pub evidence_ref: Option<&'a str>,
    pub person_scope: bool,
    pub pattern_active: bool,
    /// `Some(choices)` when the pattern is 시차출퇴근.
    pub start_choices: Option<&'a [u16]>,
    pub start_choice: Option<u16>,
    /// Closed attendance months that reach the target's people.
    pub closed_months: &'a [(i32, u8)],
}

/// # Errors
/// The first rule the assignment breaks.
pub fn check_assign(r: &AssignRules<'_>) -> Result<(), ScheduleRefusal> {
    if r.effective_to.is_some_and(|end| end <= r.effective_from) {
        return Err(ScheduleRefusal::EffectiveRangeInvalid);
    }
    if !r.pattern_active {
        return Err(ScheduleRefusal::PatternRetired);
    }
    match r.reason {
        LayerReason::Reduction if r.evidence_ref.is_none_or(|e| e.trim().is_empty()) => {
            return Err(ScheduleRefusal::EvidenceRequired);
        }
        LayerReason::Substitute
            if !r.person_scope || r.effective_to != Some(r.effective_from + Duration::days(1)) =>
        {
            return Err(ScheduleRefusal::SubstituteNeedsEnd);
        }
        _ => {}
    }
    match (r.start_choice, r.start_choices) {
        (Some(c), Some(choices)) if r.person_scope && choices.contains(&c) => {}
        (Some(_), _) => return Err(ScheduleRefusal::StartChoiceInvalid),
        (None, _) => {}
    }
    let first = month_of(r.effective_from);
    let last = r.effective_to.map(|end| month_of(end - Duration::days(1)));
    if r.closed_months
        .iter()
        .any(|m| *m >= first && last.is_none_or(|l| *m <= l))
    {
        return Err(ScheduleRefusal::MonthClosed);
    }
    Ok(())
}

/// A layer may be cancelled only before its first day (KST).
///
/// # Errors
/// `LayerInEffect` from its first day on.
pub fn check_cancel(today: Date, effective_from: Date) -> Result<(), ScheduleRefusal> {
    if effective_from > today {
        Ok(())
    } else {
        Err(ScheduleRefusal::LayerInEffect)
    }
}

#[cfg(test)]
#[path = "assign_tests.rs"]
mod tests;
