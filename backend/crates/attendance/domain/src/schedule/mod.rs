//! 근무 일정 (ATT S1): patterns, effective-dated layers and the day plan they
//! decide. Pure: no IO, no clock (callers pass `today`).

mod assign;
mod break_floor;
#[cfg(test)]
mod break_floor_tests;
mod pattern;
mod resolve;

pub use assign::{AssignRules, LayerReason, check_assign, check_cancel, month_of};
pub use break_floor::BreakFloorRow;
pub use pattern::{DaySpec, Derived, HolidayRule, PatternSpec, Shift, Slot, Window};
pub use resolve::{DayKind, DayPlan, HolidayFact, HolidayKind, LayerRef, Level, plan_day, winner};

/// Why a schedule command is refused. Each code is stable on the wire and has
/// a ko/en catalog entry in the console.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ScheduleRefusal {
    #[error(
        "a shift must start before 24:00, end after it starts, span at most 16 hours and keep its breaks inside"
    )]
    ShiftWindowInvalid,
    #[error(
        "break is below the statutory minimum (30 minutes from 4 hours, 1 hour from 8 hours of work)"
    )]
    BreakBelowMinimum,
    #[error("no statutory break floor is in force on this date")]
    BreakFloorNotInForce,
    #[error("scheduled work exceeds 8 hours in a day")]
    DailyHoursOver8,
    #[error("scheduled work exceeds 40 hours in a week")]
    WeeklyHoursOver40,
    #[error("the pattern needs at least one weekly paid holiday per 7 days")]
    WeeklyHolidayMissing,
    #[error("start choices must be 2 to 6 distinct times including the pattern's own start")]
    StartChoiceInvalid,
    #[error(
        "this working-time regime needs its written agreement record, which is not available yet"
    )]
    RegimeNotSupportedYet,
    #[error("the pattern is retired")]
    PatternRetired,
    #[error("a current or future schedule uses this pattern")]
    PatternInUse,
    #[error("the start date falls in a closed attendance month")]
    MonthClosed,
    #[error("the layer is already in effect; assign a new one from a later date instead")]
    LayerInEffect,
    #[error("a reduced schedule needs its evidence document")]
    EvidenceRequired,
    #[error("a substitute shift covers one day and needs its end date")]
    SubstituteNeedsEnd,
    #[error("the end date must be after the start date")]
    EffectiveRangeInvalid,
}

impl ScheduleRefusal {
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::ShiftWindowInvalid => "shift_window_invalid",
            Self::BreakBelowMinimum => "break_below_minimum",
            Self::BreakFloorNotInForce => "break_floor_not_in_force",
            Self::DailyHoursOver8 => "daily_hours_over_8",
            Self::WeeklyHoursOver40 => "weekly_hours_over_40",
            Self::WeeklyHolidayMissing => "weekly_holiday_missing",
            Self::StartChoiceInvalid => "start_choice_invalid",
            Self::RegimeNotSupportedYet => "regime_not_supported_yet",
            Self::PatternRetired => "pattern_retired",
            Self::PatternInUse => "pattern_in_use",
            Self::MonthClosed => "schedule_month_closed",
            Self::LayerInEffect => "schedule_layer_in_effect",
            Self::EvidenceRequired => "evidence_required",
            Self::SubstituteNeedsEnd => "substitute_needs_end",
            Self::EffectiveRangeInvalid => "effective_range_invalid",
        }
    }

    /// 409 for a state conflict, 422 for input that can never pass.
    #[must_use]
    pub const fn is_conflict(self) -> bool {
        matches!(
            self,
            Self::PatternRetired | Self::PatternInUse | Self::MonthClosed | Self::LayerInEffect
        )
    }
}
