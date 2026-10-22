//! 근무 유형: one week (or one rotation cycle) of 소정 days, validated against
//! 근로기준법 §50 (8h/40h), §54 (휴게) and §55 (주휴). Minutes are integers
//! from 00:00 of the work date; an end past 1440 is the next day.

use serde::{Deserialize, Serialize};
use time::Date;

use super::ScheduleRefusal;
use super::break_floor::{BreakFloorFinding, BreakFloorRow};

const DAY: u16 = 1440;
const DAILY_LIMIT: u16 = 480;
const MAX_SPAN: u16 = 16 * 60;
const NIGHT_FROM: u16 = 22 * 60;
const NIGHT_TO: u16 = 6 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Window {
    pub start: u16,
    pub end: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Shift {
    pub start: u16,
    pub end: u16,
    #[serde(default)]
    pub breaks: Vec<Window>,
}

impl Shift {
    /// Scheduled work minutes: the span minus its breaks.
    #[must_use]
    pub fn minutes(&self) -> u16 {
        let breaks: u16 = self.breaks.iter().map(|b| b.end - b.start).sum();
        self.end - self.start - breaks
    }

    /// Work minutes between 22:00 and 06:00 (§56③), breaks excluded.
    #[must_use]
    pub fn night_minutes(&self) -> u16 {
        let nights = [
            (0, NIGHT_TO),
            (NIGHT_FROM, DAY + NIGHT_TO),
            (DAY + NIGHT_FROM, 2 * DAY),
        ];
        let overlap = |a: u16, b: u16| -> u16 {
            nights
                .iter()
                .map(|&(s, e)| b.min(e).saturating_sub(a.max(s)))
                .sum()
        };
        let breaks: u16 = self.breaks.iter().map(|w| overlap(w.start, w.end)).sum();
        overlap(self.start, self.end) - breaks
    }

    /// The same shift moved so it starts at `start` (시차출퇴근).
    #[must_use]
    pub fn moved_to(&self, start: u16) -> Self {
        let delta = i32::from(start) - i32::from(self.start);
        let at = |m: u16| u16::try_from(i32::from(m) + delta).unwrap_or(m);
        Self {
            start,
            end: at(self.end),
            breaks: self
                .breaks
                .iter()
                .map(|b| Window {
                    start: at(b.start),
                    end: at(b.end),
                })
                .collect(),
        }
    }

    fn validate(&self) -> Result<(), ScheduleRefusal> {
        if self.start >= DAY || self.end <= self.start || self.end - self.start > MAX_SPAN {
            return Err(ScheduleRefusal::ShiftWindowInvalid);
        }
        let mut at = self.start;
        for b in &self.breaks {
            if b.start <= at || b.end <= b.start || b.end >= self.end {
                return Err(ScheduleRefusal::ShiftWindowInvalid);
            }
            at = b.end;
        }
        // §50②: 1일 소정근로는 8시간을 넘지 못합니다 (탄력적 근로시간제 제외).
        if self.minutes() > DAILY_LIMIT {
            return Err(ScheduleRefusal::DailyHoursOver8);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DaySpec {
    Work { shift: Shift },
    WeeklyHoliday,
    RestDay,
}

impl DaySpec {
    fn minutes(&self) -> u32 {
        match self {
            Self::Work { shift } => u32::from(shift.minutes()),
            _ => 0,
        }
    }
    fn night(&self) -> bool {
        matches!(self, Self::Work { shift } if shift.night_minutes() > 0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Slot {
    pub code: String,
    pub day: DaySpec,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum HolidayRule {
    /// A 공휴일 or 약정휴일 on a work day is a day off.
    #[default]
    Off,
    /// The shift runs (교대); work counts as 휴일근로 only through a 승인.
    Work,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PatternSpec {
    Weekly {
        days: Vec<DaySpec>,
    },
    Rotation {
        slots: Vec<Slot>,
    },
    Staggered {
        days: Vec<DaySpec>,
        start_choices: Vec<u16>,
    },
}

/// Facts derived from a valid spec, never typed by a person.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Derived {
    pub weekly_minutes: u32,
    pub cycle_days: u16,
    pub night_work: bool,
}

impl PatternSpec {
    /// The kind name stored beside the spec.
    #[must_use]
    pub const fn kind(&self) -> &'static str {
        match self {
            Self::Weekly { .. } => "WEEKLY",
            Self::Rotation { .. } => "ROTATION",
            Self::Staggered { .. } => "STAGGERED",
        }
    }

    /// The cycle's days in order (Monday first for a week).
    #[must_use]
    pub fn cycle(&self) -> Vec<&DaySpec> {
        match self {
            Self::Weekly { days } | Self::Staggered { days, .. } => days.iter().collect(),
            Self::Rotation { slots } => slots.iter().map(|s| &s.day).collect(),
        }
    }

    /// # Errors
    /// The first rule the spec breaks, as a refusal with a stable code.
    /// Break floors are the register rows in force on `on` (no waiver request).
    pub fn validate(&self, on: Date, floors: &[BreakFloorRow]) -> Result<Derived, ScheduleRefusal> {
        let derived = self.derive()?;
        for day in self.cycle() {
            if let DaySpec::Work { shift } = day {
                match shift.judge_break(on, floors, false) {
                    BreakFloorFinding::Below { .. } => {
                        return Err(ScheduleRefusal::BreakBelowMinimum);
                    }
                    BreakFloorFinding::NotInForce => {
                        return Err(ScheduleRefusal::BreakFloorNotInForce);
                    }
                    BreakFloorFinding::Within { .. } => {}
                }
            }
        }
        Ok(derived)
    }

    /// Derive saved facts without rejudging dated break floors.
    ///
    /// # Errors
    /// Invalid shape, shift windows, start choices, daily/weekly hours or holidays.
    pub fn derive(&self) -> Result<Derived, ScheduleRefusal> {
        match self {
            Self::Weekly { days } | Self::Staggered { days, .. } if days.len() != 7 => {
                return Err(ScheduleRefusal::ShiftWindowInvalid);
            }
            Self::Rotation { slots }
                if !(2..=56).contains(&slots.len())
                    || slots
                        .iter()
                        .any(|s| !(1..=4).contains(&s.code.chars().count())) =>
            {
                return Err(ScheduleRefusal::ShiftWindowInvalid);
            }
            _ => {}
        }
        let cycle = self.cycle();
        for day in &cycle {
            if let DaySpec::Work { shift } = day {
                shift.validate()?;
            }
        }
        if let Self::Staggered {
            days,
            start_choices,
        } = self
        {
            validate_choices(days, start_choices)?;
        }
        let len = u32::try_from(cycle.len()).unwrap_or(u32::MAX);
        let holidays = cycle
            .iter()
            .filter(|d| matches!(d, DaySpec::WeeklyHoliday))
            .count();
        // §55①: 1주에 평균 1회 이상의 유급휴일.
        if u32::try_from(holidays).unwrap_or(0) * 7 < len {
            return Err(ScheduleRefusal::WeeklyHolidayMissing);
        }
        let total: u32 = cycle.iter().map(|d| d.minutes()).sum();
        let weekly = total * 7 / len;
        if weekly > 2400 {
            return Err(ScheduleRefusal::WeeklyHoursOver40);
        }
        Ok(Derived {
            weekly_minutes: weekly,
            cycle_days: u16::try_from(len).unwrap_or(u16::MAX),
            night_work: cycle.iter().any(|d| d.night()),
        })
    }
}

fn validate_choices(days: &[DaySpec], choices: &[u16]) -> Result<(), ScheduleRefusal> {
    let base = days.iter().find_map(|d| match d {
        DaySpec::Work { shift } => Some(shift),
        _ => None,
    });
    let Some(base) = base else {
        return Err(ScheduleRefusal::StartChoiceInvalid);
    };
    let mut sorted = choices.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    if !(2..=6).contains(&choices.len())
        || sorted.len() != choices.len()
        || !choices.contains(&base.start)
    {
        return Err(ScheduleRefusal::StartChoiceInvalid);
    }
    for day in days {
        if let DaySpec::Work { shift } = day {
            for &c in choices {
                if c >= DAY || shift.moved_to(c).end > 2 * DAY {
                    return Err(ScheduleRefusal::StartChoiceInvalid);
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "pattern_tests.rs"]
mod tests;
