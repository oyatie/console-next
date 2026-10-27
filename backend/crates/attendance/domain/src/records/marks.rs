//! What a person-day needs before the month can close (spec §1.1, AT §4.5).
//! ▲ blocks the close, ◆ needs a decision, ● is for reference. The
//! thresholds are the tenant's settings; an unset one is 0 (AT-11: an
//! unconfirmed notice minute detects everything and the close says so).

use serde::{Deserialize, Serialize};

use super::recognise::Recognition;
use crate::schedule::DayKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Mark {
    /// ▲ a past work day with nothing recorded (미기록).
    NoRecord,
    /// ▲ 출근 without 퇴근 (퇴근 누락).
    MissingOut,
    /// ▲ no resolved 근무 일정, whether or not time has been recorded.
    NoSchedule,
    /// ◆ any early or late worked time outside the schedule, with no approval.
    UnapprovedExcess,
    /// ◆ work recorded on a 휴일 or 휴무일 with no 승인.
    WorkOnRestDay,
    /// ● 지각 · 조퇴 · 이탈 (미근로).
    Late,
    EarlyOut,
    Away,
    /// ● 결근 recorded on a work day.
    Absent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Tone {
    Blocking,
    Decision,
    Info,
}

impl Mark {
    #[must_use]
    pub const fn tone(self) -> Tone {
        match self {
            Self::NoRecord | Self::MissingOut | Self::NoSchedule => Tone::Blocking,
            Self::UnapprovedExcess | Self::WorkOnRestDay => Tone::Decision,
            Self::Late | Self::EarlyOut | Self::Away | Self::Absent => Tone::Info,
        }
    }
}

/// What was recorded for the day, as the marks need it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recorded {
    Nothing,
    Times,
    ClockInOnly,
    Absent,
    /// 외근 · 출장: worked elsewhere, recognised as scheduled.
    Away,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Thresholds {
    /// `attendance.excess.notice_minutes`: visual notice only; never hides excess.
    pub notice_minutes: u32,
    /// `attendance.late.grace_minutes`
    pub grace_minutes: u32,
    /// `attendance.entry.long_span_confirm_minutes`
    pub long_span_minutes: u32,
}

/// Marks of one person-day. `past` is a day before today (KST): today is
/// judged only after it ends (A1 「판정은 근무가 끝난 뒤」).
#[must_use]
pub fn marks(
    day: DayKind,
    holiday_work: bool,
    recorded: Recorded,
    rec: &Recognition,
    past: bool,
    t: Thresholds,
) -> Vec<Mark> {
    let mut out = Vec::new();
    if day == DayKind::NoSchedule {
        out.push(Mark::NoSchedule);
    }
    let work_day = day == DayKind::Work || holiday_work;
    match recorded {
        Recorded::Nothing if past && work_day => out.push(Mark::NoRecord),
        Recorded::ClockInOnly => out.push(Mark::MissingOut),
        Recorded::Absent if work_day => out.push(Mark::Absent),
        Recorded::Times if day == DayKind::NoSchedule => {}
        // Paid rest-day work still requires a recorded disposition.
        Recorded::Times if day != DayKind::Work && rec.excess_open > 0 => {
            out.push(Mark::WorkOnRestDay)
        }
        Recorded::Times => {
            if rec.excess_open > 0 {
                out.push(Mark::UnapprovedExcess);
            }
            for (minutes, mark) in [
                (rec.late_in, Mark::Late),
                (rec.early_out, Mark::EarlyOut),
                (rec.away, Mark::Away),
            ] {
                if minutes > t.grace_minutes {
                    out.push(mark);
                }
            }
        }
        _ => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(f: impl FnOnce(&mut Recognition)) -> Recognition {
        let mut r = Recognition::default();
        f(&mut r);
        r
    }
    const T: Thresholds = Thresholds {
        long_span_minutes: 0,
        notice_minutes: 10,
        grace_minutes: 0,
    };

    #[test]
    fn a_missing_day_blocks_only_once_it_is_past() {
        let none = Recognition::default();
        assert_eq!(
            marks(DayKind::Work, false, Recorded::Nothing, &none, true, T),
            vec![Mark::NoRecord]
        );
        assert!(marks(DayKind::Work, false, Recorded::Nothing, &none, false, T).is_empty());
        assert!(
            marks(
                DayKind::WeeklyHoliday,
                false,
                Recorded::Nothing,
                &none,
                true,
                T
            )
            .is_empty()
        );
        assert_eq!(
            marks(
                DayKind::PublicHoliday,
                true,
                Recorded::Nothing,
                &none,
                true,
                T
            ),
            vec![Mark::NoRecord]
        );
    }

    #[test]
    fn a_stay_over_the_notice_needs_a_decision_and_shortfalls_are_reference() {
        let stay = rec(|r| {
            r.recorded = 610;
            r.recognised = 480;
            r.late_unrecognised = 130;
            r.excess_open = 130;
            r.late_in = 10;
        });
        assert_eq!(
            marks(DayKind::Work, false, Recorded::Times, &stay, true, T),
            vec![Mark::UnapprovedExcess, Mark::Late]
        );
        let short = rec(|r| {
            r.late_unrecognised = 10;
            r.excess_open = 10;
        });
        assert_eq!(
            marks(DayKind::Work, false, Recorded::Times, &short, true, T),
            vec![Mark::UnapprovedExcess],
            "notice never hides worked excess"
        );
        let unset = Thresholds::default();
        assert_eq!(
            marks(DayKind::Work, false, Recorded::Times, &short, true, unset),
            vec![Mark::UnapprovedExcess]
        );
    }

    #[test]
    fn rest_day_work_and_no_schedule_and_clock_in_only() {
        let worked = rec(|r| {
            r.recorded = 240;
            r.recognised = 240;
            r.excess_open = 240;
        });
        assert_eq!(
            marks(
                DayKind::WeeklyHoliday,
                false,
                Recorded::Times,
                &worked,
                true,
                T
            ),
            vec![Mark::WorkOnRestDay]
        );
        assert_eq!(
            marks(
                DayKind::NoSchedule,
                false,
                Recorded::Times,
                &worked,
                true,
                T
            ),
            vec![Mark::NoSchedule]
        );
        assert_eq!(
            marks(
                DayKind::Work,
                false,
                Recorded::ClockInOnly,
                &worked,
                false,
                T
            ),
            vec![Mark::MissingOut]
        );
        assert_eq!(
            marks(DayKind::Work, false, Recorded::Absent, &worked, true, T),
            vec![Mark::Absent]
        );
        assert_eq!(Mark::NoRecord.tone(), Tone::Blocking);
        assert_eq!(Mark::WorkOnRestDay.tone(), Tone::Decision);
    }
}
