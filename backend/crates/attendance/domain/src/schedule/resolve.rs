//! Which layer decides a person's day, and what that day is.
//! Precedence: 사람 › 근무조 › 부서 (nearest ancestor first) › 사업장 › 법인.
//! At one level the latest start wins; a bounded layer stops at its end.

use serde::{Deserialize, Serialize};
use time::Date;
use uuid::Uuid;

use super::pattern::{DaySpec, HolidayRule, PatternSpec, Shift};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Level {
    LegalEntity,
    Workplace,
    Department,
    Crew,
    Person,
}

impl Level {
    /// Nearest first.
    pub const PRECEDENCE: [Self; 5] = [
        Self::Person,
        Self::Crew,
        Self::Department,
        Self::Workplace,
        Self::LegalEntity,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::LegalEntity => "LEGAL_ENTITY",
            Self::Workplace => "WORKPLACE",
            Self::Department => "DEPARTMENT",
            Self::Crew => "CREW",
            Self::Person => "PERSON",
        }
    }

    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        Self::PRECEDENCE.into_iter().find(|l| l.as_str() == raw)
    }
}

/// One active layer as the resolver needs it. `depth` orders 부서 layers:
/// 0 is the person's own 부서, 1 its parent, and so on (0 elsewhere).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayerRef {
    pub id: Uuid,
    pub level: Level,
    pub depth: u8,
    pub pattern_id: Uuid,
    pub effective_from: Date,
    pub effective_to: Option<Date>,
    pub version: i32,
    pub rotation_start: Option<Date>,
    pub start_choice: Option<u16>,
}

impl LayerRef {
    #[must_use]
    pub fn active_on(&self, date: Date) -> bool {
        self.effective_from <= date && self.effective_to.is_none_or(|end| date < end)
    }
}

/// The layer that decides `date` among the layers that reach one person.
#[must_use]
pub fn winner(layers: &[LayerRef], date: Date) -> Option<&LayerRef> {
    Level::PRECEDENCE.into_iter().find_map(|level| {
        layers
            .iter()
            .filter(|l| l.level == level && l.active_on(date))
            .min_by_key(|l| (l.depth, std::cmp::Reverse((l.effective_from, l.version))))
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum HolidayKind {
    National,
    Substitute,
    Election,
    LaborDay,
    Contractual,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HolidayFact {
    pub name: String,
    pub kind: HolidayKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DayKind {
    Work,
    WeeklyHoliday,
    RestDay,
    PublicHoliday,
    SubstituteHoliday,
    ElectionDay,
    LaborDay,
    ContractualHoliday,
    /// No layer reaches the person: nothing is recognised and the day is an
    /// exception, never an invented 09–18 (ideal AT-04).
    NoSchedule,
}

impl From<HolidayKind> for DayKind {
    fn from(kind: HolidayKind) -> Self {
        match kind {
            HolidayKind::National => Self::PublicHoliday,
            HolidayKind::Substitute => Self::SubstituteHoliday,
            HolidayKind::Election => Self::ElectionDay,
            HolidayKind::LaborDay => Self::LaborDay,
            HolidayKind::Contractual => Self::ContractualHoliday,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DayPlan {
    pub kind: DayKind,
    pub shift: Option<Shift>,
    pub slot_code: Option<String>,
    pub holiday_name: Option<String>,
    pub holiday_work: bool,
}

impl DayPlan {
    #[must_use]
    pub fn unscheduled(holiday: Option<&HolidayFact>) -> Self {
        Self {
            kind: DayKind::NoSchedule,
            shift: None,
            slot_code: None,
            holiday_name: holiday.map(|h| h.name.clone()),
            holiday_work: false,
        }
    }
}

/// The day `layer`'s pattern gives on `date`, with the holiday applied.
#[must_use]
pub fn plan_day(
    spec: &PatternSpec,
    rule: HolidayRule,
    layer: &LayerRef,
    date: Date,
    holiday: Option<&HolidayFact>,
) -> DayPlan {
    let cycle = spec.cycle();
    let (index, slot_code) = match spec {
        PatternSpec::Rotation { slots } => {
            let start = layer.rotation_start.unwrap_or(layer.effective_from);
            let len = i64::try_from(slots.len()).unwrap_or(1).max(1);
            let i = usize::try_from((date - start).whole_days().rem_euclid(len)).unwrap_or(0);
            (i, slots.get(i).map(|s| s.code.clone()))
        }
        _ => (usize::from(date.weekday().number_days_from_monday()), None),
    };
    let day = cycle.get(index).copied();
    let shift = match day {
        Some(DaySpec::Work { shift }) => Some(match (spec, layer.start_choice) {
            (PatternSpec::Staggered { .. }, Some(start)) => shift.moved_to(start),
            _ => shift.clone(),
        }),
        _ => None,
    };
    let base = match day {
        Some(DaySpec::Work { .. }) => DayKind::Work,
        Some(DaySpec::WeeklyHoliday) => DayKind::WeeklyHoliday,
        _ => DayKind::RestDay,
    };
    let holiday_name = holiday.map(|h| h.name.clone());
    match (base, holiday) {
        (DayKind::Work, Some(h)) => {
            let works = rule == HolidayRule::Work;
            DayPlan {
                kind: h.kind.into(),
                shift: if works { shift } else { None },
                slot_code,
                holiday_name,
                holiday_work: works,
            }
        }
        _ => DayPlan {
            kind: base,
            shift,
            slot_code,
            holiday_name,
            holiday_work: false,
        },
    }
}

#[cfg(test)]
#[path = "resolve_tests.rs"]
mod tests;
