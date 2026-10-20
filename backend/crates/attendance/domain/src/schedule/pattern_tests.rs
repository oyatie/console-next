use time::Date;
use time::macros::date;

use super::*;

fn floor_on() -> Date {
    date!(2026 - 10 - 20)
}

fn korea_floors() -> Vec<BreakFloorRow> {
    vec![
        BreakFloorRow {
            code: "lsa.s54.at_4h".into(),
            effective_from: date!(2026 - 10 - 08),
            effective_to_exclusive: None,
            work_minutes: 240,
            rest_minutes: 30,
            waiver: false,
        },
        BreakFloorRow {
            code: "lsa.s54.at_8h".into(),
            effective_from: date!(2026 - 10 - 08),
            effective_to_exclusive: None,
            work_minutes: 480,
            rest_minutes: 60,
            waiver: false,
        },
        BreakFloorRow {
            code: "lsa.s54.waiver_4h".into(),
            effective_from: date!(2026 - 12 - 10),
            effective_to_exclusive: None,
            work_minutes: 240,
            rest_minutes: 0,
            waiver: true,
        },
    ]
}

fn w(start: u16, end: u16) -> Window {
    Window { start, end }
}
fn work(start: u16, end: u16, breaks: &[(u16, u16)]) -> DaySpec {
    DaySpec::Work {
        shift: Shift {
            start,
            end,
            breaks: breaks.iter().map(|&(s, e)| w(s, e)).collect(),
        },
    }
}
fn office() -> DaySpec {
    work(540, 1080, &[(720, 780)])
}
fn week(day: DaySpec) -> Vec<DaySpec> {
    let mut days = vec![day; 5];
    days.push(DaySpec::RestDay);
    days.push(DaySpec::WeeklyHoliday);
    days
}

#[test]
fn a_five_day_office_week_is_40_hours_with_a_seven_day_cycle() {
    let d = PatternSpec::Weekly {
        days: week(office()),
    }
    .validate(floor_on(), &korea_floors())
    .unwrap();
    assert_eq!(
        (d.weekly_minutes, d.cycle_days, d.night_work),
        (2400, 7, false)
    );
}

#[test]
fn breaks_follow_section_54() {
    // 8 hours of work with 30 minutes of rest.
    let short = work(540, 1050, &[(720, 750)]);
    assert_eq!(
        PatternSpec::Weekly { days: week(short) }.validate(floor_on(), &korea_floors()),
        Err(ScheduleRefusal::BreakBelowMinimum)
    );
    // 4h30 of work with no break at all.
    let none = work(540, 810, &[]);
    assert_eq!(
        PatternSpec::Weekly { days: week(none) }.validate(floor_on(), &korea_floors()),
        Err(ScheduleRefusal::BreakBelowMinimum)
    );
    // 3h59 needs none.
    assert!(
        PatternSpec::Weekly {
            days: week(work(540, 779, &[]))
        }
        .validate(floor_on(), &korea_floors())
        .is_ok()
    );
}

#[test]
fn a_day_over_8_hours_and_a_week_over_40_are_refused() {
    let long = work(480, 1140, &[(720, 780)]); // 10h of work
    assert_eq!(
        PatternSpec::Weekly { days: week(long) }.validate(floor_on(), &korea_floors()),
        Err(ScheduleRefusal::DailyHoursOver8)
    );
    let mut six = vec![office(); 6];
    six.push(DaySpec::WeeklyHoliday);
    assert_eq!(
        PatternSpec::Weekly { days: six }.validate(floor_on(), &korea_floors()),
        Err(ScheduleRefusal::WeeklyHoursOver40)
    );
}

#[test]
fn a_week_without_a_weekly_holiday_is_refused() {
    let mut days = vec![office(); 5];
    days.extend([DaySpec::RestDay, DaySpec::RestDay]);
    assert_eq!(
        PatternSpec::Weekly { days }.validate(floor_on(), &korea_floors()),
        Err(ScheduleRefusal::WeeklyHolidayMissing)
    );
}

#[test]
fn breaks_must_sit_inside_the_shift_in_order() {
    for breaks in [
        &[(500, 560)][..],
        &[(1070, 1100)],
        &[(780, 840), (720, 750)],
    ] {
        assert_eq!(
            PatternSpec::Weekly {
                days: week(work(540, 1080, breaks))
            }
            .validate(floor_on(), &korea_floors()),
            Err(ScheduleRefusal::ShiftWindowInvalid),
            "{breaks:?}"
        );
    }
}

#[test]
fn a_night_shift_crosses_midnight_and_counts_night_minutes() {
    // 22:00 – 07:00 next day, break 02:00 – 03:00: 8h of work, 7h of it at night.
    let night = Shift {
        start: 1320,
        end: 1860,
        breaks: vec![w(1560, 1620)],
    };
    assert_eq!((night.minutes(), night.night_minutes()), (480, 420));
}

#[test]
fn a_rotation_cycle_is_derived_from_its_slots_and_averaged_per_week() {
    let day = work(480, 1020, &[(720, 780)]); // 8h
    let night = work(1260, 1800, &[(1560, 1620)]); // 21:00 – 06:00, 8h
    let slot = |code: &str, day: DaySpec| Slot {
        code: code.into(),
        day,
    };
    let spec = PatternSpec::Rotation {
        slots: vec![
            slot("주", day.clone()),
            slot("주", day),
            slot("야", night.clone()),
            slot("야", night),
            slot("비", DaySpec::RestDay),
            slot("휴", DaySpec::WeeklyHoliday),
        ],
    };
    let d = spec.validate(floor_on(), &korea_floors()).unwrap();
    assert_eq!(
        (d.cycle_days, d.weekly_minutes, d.night_work),
        (6, 4 * 480 * 7 / 6, true)
    );
}

#[test]
fn staggered_starts_include_the_base_and_stay_distinct() {
    let ok = PatternSpec::Staggered {
        days: week(office()),
        start_choices: vec![480, 540, 600],
    };
    assert!(ok.validate(floor_on(), &korea_floors()).is_ok());
    for choices in [vec![480, 600], vec![540, 540], vec![540]] {
        let spec = PatternSpec::Staggered {
            days: week(office()),
            start_choices: choices.clone(),
        };
        assert_eq!(
            spec.validate(floor_on(), &korea_floors()),
            Err(ScheduleRefusal::StartChoiceInvalid),
            "{choices:?}"
        );
    }
}

#[test]
fn break_floor_thresholds_are_not_literals_in_pattern_rs() {
    let src = include_str!("pattern.rs");
    assert!(
        !src.contains("work >= 240") && !src.contains("rest < 30"),
        "4-hour floor is still a literal"
    );
    assert!(
        !src.contains("work >= 480") && !src.contains("rest < 60"),
        "8-hour floor is still a literal"
    );
}

fn governing(finding: BreakFloorFinding<'_>) -> &str {
    match finding {
        BreakFloorFinding::Within {
            governing: Some(row),
        }
        | BreakFloorFinding::Below { governing: row } => row.code.as_str(),
        BreakFloorFinding::Within { governing: None } => "none",
        BreakFloorFinding::NotInForce => "not_in_force",
    }
}

#[test]
fn break_floor_comes_from_dated_register_rows() {
    let rows = korea_floors();
    let four = Shift {
        start: 540,
        end: 780,
        breaks: vec![],
    };
    let on = date!(2026 - 12 - 10);
    let before = date!(2026 - 12 - 09);

    let waived = four.judge_break(on, &rows, true);
    assert_eq!(governing(waived), "lsa.s54.waiver_4h");
    assert!(matches!(waived, BreakFloorFinding::Within { .. }));

    let early = four.judge_break(before, &rows, true);
    assert_eq!(governing(early), "lsa.s54.at_4h");
    assert!(matches!(early, BreakFloorFinding::Below { .. }));

    // The proviso needs an explicit request. Absence keeps the 4-hour floor.
    let no_request = four.judge_break(on, &rows, false);
    assert_eq!(governing(no_request), "lsa.s54.at_4h");
    assert!(matches!(no_request, BreakFloorFinding::Below { .. }));

    let mut edited = rows.clone();
    edited[2].effective_from = date!(2027 - 01 - 01);
    let moved = four.judge_break(on, &edited, true);
    assert_eq!(governing(moved), "lsa.s54.at_4h");
    assert!(matches!(moved, BreakFloorFinding::Below { .. }));

    edited[2].effective_from = on;
    edited[2].rest_minutes = 20;
    let stricter = four.judge_break(on, &edited, true);
    assert_eq!(governing(stricter), "lsa.s54.waiver_4h");
    assert!(matches!(stricter, BreakFloorFinding::Below { .. }));

    let eight = Shift {
        start: 540,
        end: 1050,
        breaks: vec![w(720, 750)],
    };
    let eight_j = eight.judge_break(on, &rows, false);
    assert_eq!(governing(eight_j), "lsa.s54.at_8h");
    assert!(matches!(eight_j, BreakFloorFinding::Below { .. }));

    // Two windows inside the span sum to the 4-hour band.
    let split = Shift {
        start: 540,
        end: 810,
        breaks: vec![w(600, 615), w(700, 715)],
    };
    let split_j = split.judge_break(floor_on(), &rows, false);
    assert_eq!(governing(split_j), "lsa.s54.at_4h");
    assert!(matches!(split_j, BreakFloorFinding::Within { .. }));

    let under = Shift {
        start: 540,
        end: 779,
        breaks: vec![],
    };
    assert_eq!(
        under.judge_break(floor_on(), &rows, false),
        BreakFloorFinding::Within { governing: None }
    );
    assert_eq!(
        four.judge_break(date!(2026 - 10 - 07), &rows, true),
        BreakFloorFinding::NotInForce
    );
}

#[test]
fn nothing_recorded_deducts_planned_breaks_and_nothing_beyond_them() {
    let planned = [w(720, 780)];
    assert_eq!(deducted_break_minutes(540, 1080, &planned, None), 60);
    let recorded = [w(720, 740)];
    assert_eq!(
        deducted_break_minutes(540, 1080, &planned, Some(&recorded)),
        20
    );
    assert_eq!(deducted_break_minutes(540, 1080, &[], None), 0);
    let outside = [w(100, 160)];
    assert_eq!(
        deducted_break_minutes(540, 1080, &planned, Some(&outside)),
        0
    );
    let crossing = [w(1000, 1100)];
    assert_eq!(
        deducted_break_minutes(540, 1080, &planned, Some(&crossing)),
        80
    );
}

#[test]
fn a_moved_shift_keeps_its_length_and_breaks() {
    let s = Shift {
        start: 540,
        end: 1080,
        breaks: vec![w(720, 780)],
    };
    let m = s.moved_to(600);
    assert_eq!(
        (m.start, m.end, m.breaks[0].start, m.minutes()),
        (600, 1140, 780, 480)
    );
}
