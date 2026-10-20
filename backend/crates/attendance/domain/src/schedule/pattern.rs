//! 근무 유형: one week (or one rotation cycle) of 소정 days, validated against
//! 근로기준법 §50 (8h/40h), §54 (휴게) and §55 (주휴). Minutes are integers
//! from 00:00 of the work date; an end past 1440 is the next day.

use serde::{Deserialize, Serialize};
use time::Date;

use super::ScheduleRefusal;

const DAY: u16 = 1440;
const MAX_SPAN: u16 = 16 * 60;
const NIGHT_FROM: u16 = 22 * 60;
const NIGHT_TO: u16 = 6 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Window {
    pub start: u16,
    pub end: u16,
}

/// One dated §54① band from the break-floor register.
///
/// A non-waiver row applies when worked minutes are at least `work_minutes`
/// and then requires `rest_minutes`. A waiver row applies only on its dates,
/// only when worked minutes equal `work_minutes`, and only when the worker
/// asked to skip the break. The numbers live on the row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BreakFloorRow {
    pub code: String,
    pub effective_from: Date,
    pub effective_to_exclusive: Option<Date>,
    pub work_minutes: u16,
    pub rest_minutes: u16,
    pub waiver: bool,
}

/// Which register row judged a shift, if any band was in force.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BreakFloorFinding<'a> {
    /// `governing` is the strictest band that applied. `None` means the worked
    /// length sits under every band in force.
    Within {
        governing: Option<&'a BreakFloorRow>,
    },
    Below {
        governing: &'a BreakFloorRow,
    },
    /// No register row covers `on`. Fail closed: do not guess a floor.
    NotInForce,
}

/// Minutes removed from a span.
///
/// Nothing recorded (`recorded == None`) uses the planned windows. A recording,
/// including an empty one, uses that recording. Minutes outside the span do
/// not count. The statutory floor is never inserted on top.
#[must_use]
pub fn deducted_break_minutes(
    span_start: u16,
    span_end: u16,
    planned: &[Window],
    recorded: Option<&[Window]>,
) -> u16 {
    let source = recorded.unwrap_or(planned);
    let total: u32 = source
        .iter()
        .map(|w| u32::from(overlap(span_start, span_end, w.start, w.end)))
        .sum();
    u16::try_from(total).unwrap_or(u16::MAX)
}

fn overlap(span_start: u16, span_end: u16, start: u16, end: u16) -> u16 {
    end.min(span_end).saturating_sub(start.max(span_start))
}

fn row_in_force(row: &BreakFloorRow, on: Date) -> bool {
    on >= row.effective_from && row.effective_to_exclusive.is_none_or(|end| on < end)
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

    /// §54① against the register rows in force on `on`. `waiver_requested` is the
    /// worker's explicit ask to skip the break; without it the waiver row does
    /// not apply.
    #[must_use]
    pub fn judge_break<'a>(
        &self,
        on: Date,
        floors: &'a [BreakFloorRow],
        waiver_requested: bool,
    ) -> BreakFloorFinding<'a> {
        let active: Vec<&BreakFloorRow> = floors.iter().filter(|r| row_in_force(r, on)).collect();
        if active.is_empty() {
            return BreakFloorFinding::NotInForce;
        }
        let rest = deducted_break_minutes(self.start, self.end, &self.breaks, None);
        let work = self.minutes();
        if waiver_requested
            && let Some(waiver) = active
                .iter()
                .copied()
                .filter(|r| r.waiver && r.work_minutes == work)
                .max_by_key(|r| r.effective_from)
        {
            return if rest < waiver.rest_minutes {
                BreakFloorFinding::Below { governing: waiver }
            } else {
                BreakFloorFinding::Within {
                    governing: Some(waiver),
                }
            };
        }
        let applicable: Vec<&BreakFloorRow> = active
            .iter()
            .copied()
            .filter(|r| !r.waiver && work >= r.work_minutes)
            .collect();
        let Some(governing) = applicable.iter().copied().max_by_key(|r| r.work_minutes) else {
            return BreakFloorFinding::Within { governing: None };
        };
        if let Some(short) = applicable
            .iter()
            .copied()
            .filter(|r| rest < r.rest_minutes)
            .max_by_key(|r| (r.rest_minutes, r.work_minutes))
        {
            return BreakFloorFinding::Below { governing: short };
        }
        BreakFloorFinding::Within {
            governing: Some(governing),
        }
    }

    fn validate(&self, on: Date, floors: &[BreakFloorRow]) -> Result<(), ScheduleRefusal> {
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
        // §54① bands and the dated 4-hour waiver come from the register.
        match self.judge_break(on, floors, false) {
            BreakFloorFinding::Below { .. } => return Err(ScheduleRefusal::BreakBelowMinimum),
            BreakFloorFinding::NotInForce => return Err(ScheduleRefusal::BreakFloorNotInForce),
            BreakFloorFinding::Within { .. } => {}
        }
        // §50②: 1일 소정근로는 8시간을 넘지 못합니다 (탄력적 근로시간제 제외).
        if self.minutes() > 8_u16 * 60 {
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
                shift.validate(on, floors)?;
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
