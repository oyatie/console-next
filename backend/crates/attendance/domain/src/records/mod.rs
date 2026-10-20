//! 근태 기록 (ATT S2): the entry grammar, the recognition rule and the marks
//! of a person-day. Pure: callers pass the plan, the entry and `today`.

mod grammar;
mod marks;
mod recognise;

pub use grammar::{Entry, ParseRefusal, parse};
pub use marks::{Mark, Recorded, Thresholds, Tone, marks};
pub use recognise::{Minutes, Recognition, recognise, scheduled};

use serde::{Deserialize, Serialize};

use crate::schedule::{DayKind, DayPlan, Window};

/// A stored entry's kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EntryKind {
    Times,
    ClockInOnly,
    Absent,
    OutsideWork,
    BusinessTrip,
    Void,
}

impl EntryKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Times => "TIMES",
            Self::ClockInOnly => "CLOCK_IN_ONLY",
            Self::Absent => "ABSENT",
            Self::OutsideWork => "OUTSIDE_WORK",
            Self::BusinessTrip => "BUSINESS_TRIP",
            Self::Void => "VOID",
        }
    }
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        [
            Self::Times,
            Self::ClockInOnly,
            Self::Absent,
            Self::OutsideWork,
            Self::BusinessTrip,
            Self::Void,
        ]
        .into_iter()
        .find(|k| k.as_str() == raw)
    }
}

/// Why a cell cannot be saved beyond its grammar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CellRefusal {
    Parse(ParseRefusal),
    /// `=` on a day with no shift to copy (휴일 · 휴무일 · 일정 없음).
    NoShiftToCopy,
    /// 기록 for a day that has not come yet (외근 · 출장 plans excepted).
    FutureDate,
    /// `휴` on a planned workday, or a shift code other than the planned
    /// slot: only the 근무 일정 changes the plan (input patterns I6).
    ScheduleChangeNeeded,
    /// `휴` (or the day's own off slot) on a day the plan already has off.
    AlreadyDayOff,
    /// `-18`: read, but the store has no 퇴근-only kind yet.
    ClockOutOnlyNotStored,
    /// `연차` · `반` …: read, but 휴가 is not an attendance 기록 and the leave
    /// domain is not in this build.
    LeaveNotStored,
}

impl CellRefusal {
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Parse(p) => p.code(),
            Self::NoShiftToCopy => "no_shift_to_copy",
            Self::FutureDate => "future_date",
            Self::ScheduleChangeNeeded => "schedule_change_needed",
            Self::AlreadyDayOff => "already_day_off",
            Self::ClockOutOnlyNotStored => "clock_out_only_not_stored",
            Self::LeaveNotStored => "leave_not_stored",
        }
    }
}

/// The entry a typed value stores: its kind and segments (minutes). The plan
/// decides what the grammar cannot: `22-07` on a shift that crosses midnight,
/// a shift code against the planned slot, `휴` against a planned workday.
///
/// # Errors
/// The grammar's refusal, `=` with nothing to copy, a future 기록, a value
/// that needs a 근무 일정 change, or a reading the store cannot hold yet.
pub fn resolve_value(
    raw: &str,
    plan: &DayPlan,
    future: bool,
    long_span_minutes: u32,
    confirmed: bool,
) -> Result<(EntryKind, Vec<Window>), CellRefusal> {
    let shift = plan
        .shift
        .as_ref()
        .filter(|_| plan.kind == DayKind::Work || plan.holiday_work);
    let overnight = shift.is_some_and(|s| s.end > 1440);
    let entry = parse(raw, long_span_minutes, confirmed, overnight).map_err(CellRefusal::Parse)?;
    let record = |kind, segments| {
        if future {
            Err(CellRefusal::FutureDate)
        } else {
            Ok((kind, segments))
        }
    };
    let as_scheduled = || match shift {
        _ if future => Err(CellRefusal::FutureDate),
        Some(s) => Ok((
            EntryKind::Times,
            vec![Window {
                start: s.start,
                end: s.end,
            }],
        )),
        None => Err(CellRefusal::NoShiftToCopy),
    };
    match entry {
        Entry::Times(spans) => record(EntryKind::Times, spans),
        Entry::ClockInOnly(start) => record(
            EntryKind::ClockInOnly,
            vec![Window {
                start,
                end: start + 1,
            }],
        ),
        Entry::AsScheduled => as_scheduled(),
        Entry::Shift(code)
            if plan
                .slot_code
                .as_deref()
                .is_some_and(|s| s.eq_ignore_ascii_case(&code)) =>
        {
            if shift.is_some() {
                as_scheduled()
            } else {
                Err(CellRefusal::AlreadyDayOff)
            }
        }
        Entry::Shift(_) => Err(CellRefusal::ScheduleChangeNeeded),
        Entry::DayOff if shift.is_some() || plan.kind == DayKind::NoSchedule => {
            Err(CellRefusal::ScheduleChangeNeeded)
        }
        Entry::DayOff => Err(CellRefusal::AlreadyDayOff),
        Entry::ClockOutOnly(_) => Err(CellRefusal::ClockOutOnlyNotStored),
        Entry::Leave(_) => Err(CellRefusal::LeaveNotStored),
        Entry::Absent => record(EntryKind::Absent, vec![]),
        Entry::OutsideWork => Ok((EntryKind::OutsideWork, vec![])),
        Entry::BusinessTrip => Ok((EntryKind::BusinessTrip, vec![])),
    }
}

/// Recognition of a stored entry on its planned day. 외근 · 출장 count as the
/// 소정 (근로기준법 §58①); 결근 and nothing recognise nothing. A 휴일 has no
/// 소정 even when a 교대 runs through it: its work is recognised only by 승인.
#[must_use]
pub fn evaluate(
    plan: &DayPlan,
    kind: Option<EntryKind>,
    segments: &[Window],
    approved: &[Window],
) -> (Recorded, Recognition) {
    let shift = plan.shift.as_ref().filter(|_| plan.kind == DayKind::Work);
    match kind {
        None | Some(EntryKind::Void) => (Recorded::Nothing, recognise(&[], shift, approved)),
        Some(EntryKind::Absent) => (Recorded::Absent, recognise(&[], shift, approved)),
        Some(EntryKind::ClockInOnly) => (Recorded::ClockInOnly, Recognition::default()),
        Some(EntryKind::OutsideWork | EntryKind::BusinessTrip) => {
            let span = shift
                .map(|s| {
                    vec![Window {
                        start: s.start,
                        end: s.end,
                    }]
                })
                .unwrap_or_default();
            (Recorded::Away, recognise(&span, shift, approved))
        }
        Some(EntryKind::Times) => (Recorded::Times, recognise(segments, shift, approved)),
    }
}

#[cfg(test)]
mod value_tests {
    use super::*;
    use crate::schedule::{DayKind, Shift};

    fn plan() -> DayPlan {
        DayPlan {
            kind: DayKind::Work,
            shift: Some(Shift {
                start: 540,
                end: 1080,
                breaks: vec![],
            }),
            slot_code: None,
            holiday_name: None,
            holiday_work: false,
        }
    }

    #[test]
    fn confirmation_never_bypasses_future_date_or_missing_schedule_guards() {
        assert_eq!(
            resolve_value("5-23", &plan(), true, 960, true),
            Err(CellRefusal::FutureDate)
        );
        assert_eq!(CellRefusal::FutureDate.code(), "future_date");
        assert_eq!(
            resolve_value("5-23", &plan(), false, 960, false)
                .unwrap_err()
                .code(),
            "span_too_long"
        );
        assert_eq!(
            resolve_value("5-23", &plan(), false, 960, true).unwrap().0,
            EntryKind::Times
        );
        assert_eq!(
            resolve_value("o", &plan(), true, 960, false).unwrap().0,
            EntryKind::OutsideWork
        );
        assert_eq!(
            resolve_value("출장", &plan(), true, 960, false).unwrap().0,
            EntryKind::BusinessTrip
        );
        assert_eq!(
            resolve_value("x", &plan(), false, 960, false).unwrap(),
            (EntryKind::Absent, vec![])
        );
        assert_eq!(
            resolve_value("7:52-", &plan(), false, 960, false).unwrap(),
            (
                EntryKind::ClockInOnly,
                vec![Window {
                    start: 472,
                    end: 473
                }]
            )
        );
        assert_eq!(
            resolve_value("=", &plan(), false, 960, false).unwrap(),
            (
                EntryKind::Times,
                vec![Window {
                    start: 540,
                    end: 1080
                }]
            )
        );
        let mut rest = plan();
        rest.kind = DayKind::RestDay;
        assert_eq!(
            resolve_value("=", &rest, false, 960, true),
            Err(CellRefusal::NoShiftToCopy)
        );
        assert_eq!(CellRefusal::NoShiftToCopy.code(), "no_shift_to_copy");
        rest.holiday_work = true;
        assert!(resolve_value("=", &rest, false, 960, true).is_ok());
        rest.shift = None;
        assert_eq!(
            resolve_value("=", &rest, false, 960, true),
            Err(CellRefusal::NoShiftToCopy)
        );
    }

    fn slot(code: &str, kind: DayKind, shift: Option<(u16, u16)>) -> DayPlan {
        DayPlan {
            kind,
            shift: shift.map(|(start, end)| Shift {
                start,
                end,
                breaks: vec![],
            }),
            slot_code: Some(code.to_owned()),
            holiday_name: None,
            holiday_work: false,
        }
    }

    fn refusal(raw: &str, plan: &DayPlan, future: bool) -> &'static str {
        resolve_value(raw, plan, future, 960, false)
            .map_or_else(|r| r.code(), |(kind, _)| kind.as_str())
    }

    #[test]
    fn the_plan_reads_night_ends_shift_codes_and_days_off() {
        let night = slot("N", DayKind::Work, Some((1320, 1860)));
        let day = plan();
        let off = slot("비", DayKind::RestDay, None);
        let window = |start, end| vec![Window { start, end }];
        assert_eq!(
            resolve_value("22-07", &night, false, 960, false),
            Ok((EntryKind::Times, window(1320, 1860)))
        );
        assert_eq!(refusal("22-07", &day, false), "overnight_without_marker");
        assert_eq!(
            resolve_value("n", &night, false, 960, false),
            Ok((EntryKind::Times, window(1320, 1860)))
        );
        assert_eq!(refusal("N", &night, true), "future_date");
        assert_eq!(refusal("D", &night, false), "schedule_change_needed");
        assert_eq!(refusal("D", &day, false), "schedule_change_needed");
        assert_eq!(refusal("비", &off, false), "already_day_off");
        assert_eq!(refusal("휴", &night, false), "schedule_change_needed");
        assert_eq!(refusal("OFF", &off, false), "already_day_off");
        let unscheduled = DayPlan::unscheduled(None);
        assert_eq!(
            refusal("휴무", &unscheduled, false),
            "schedule_change_needed"
        );
        assert_eq!(refusal("D", &unscheduled, false), "schedule_change_needed");
        for raw in ["연차", "반", "v", "병가"] {
            assert_eq!(refusal(raw, &day, false), "leave_not_stored", "{raw}");
            assert_eq!(refusal(raw, &day, true), "leave_not_stored", "{raw}");
        }
        assert_eq!(refusal("-18", &day, false), "clock_out_only_not_stored");
        assert_eq!(refusal("9–18", &day, false), "TIMES");
        assert_eq!(refusal("결", &day, true), "future_date");
        assert_eq!(refusal("외", &day, true), "OUTSIDE_WORK");
        assert_eq!(
            resolve_value("재택", &day, false, 960, false),
            Ok((EntryKind::Times, window(540, 1080)))
        );
        assert_eq!(refusal("지각", &day, false), "status_is_derived");
    }
}

#[cfg(test)]
mod kind_tests {
    use super::*;

    #[test]
    fn stored_entry_kinds_round_trip_and_refuse_unknown_codes() {
        for (kind, code) in [
            (EntryKind::Times, "TIMES"),
            (EntryKind::ClockInOnly, "CLOCK_IN_ONLY"),
            (EntryKind::Absent, "ABSENT"),
            (EntryKind::OutsideWork, "OUTSIDE_WORK"),
            (EntryKind::BusinessTrip, "BUSINESS_TRIP"),
            (EntryKind::Void, "VOID"),
        ] {
            assert_eq!(kind.as_str(), code);
            assert_eq!(EntryKind::parse(code), Some(kind));
            assert_eq!(EntryKind::parse(&code.to_lowercase()), None);
        }
        assert_eq!(EntryKind::parse(""), None);
        assert_eq!(EntryKind::parse("UNKNOWN"), None);
    }

    #[test]
    fn evaluating_raw_evidence_requires_a_work_plan_for_scheduled_recognition() {
        let mut plan = DayPlan {
            kind: DayKind::Work,
            shift: Some(crate::schedule::Shift {
                start: 540,
                end: 1080,
                breaks: vec![],
            }),
            slot_code: None,
            holiday_name: None,
            holiday_work: false,
        };
        let span = [Window {
            start: 540,
            end: 1080,
        }];
        let (recorded, rec) = evaluate(&plan, Some(EntryKind::Times), &span, &[]);
        assert_eq!(recorded, Recorded::Times);
        assert_eq!(rec.recognised, 540);
        for kind in [
            None,
            Some(EntryKind::Void),
            Some(EntryKind::Absent),
            Some(EntryKind::ClockInOnly),
        ] {
            assert_eq!(evaluate(&plan, kind, &span, &[]).1.recognised, 0);
        }
        for kind in [EntryKind::OutsideWork, EntryKind::BusinessTrip] {
            assert_eq!(evaluate(&plan, Some(kind), &[], &[]).1.recognised, 540);
        }
        plan.kind = DayKind::RestDay;
        assert_eq!(
            evaluate(&plan, Some(EntryKind::Times), &span, &[])
                .1
                .recognised,
            0
        );
        assert_eq!(
            evaluate(&plan, Some(EntryKind::OutsideWork), &[], &[])
                .1
                .recognised,
            0
        );
    }
}
