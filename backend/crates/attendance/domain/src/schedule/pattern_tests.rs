use super::*;

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
    .validate()
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
        PatternSpec::Weekly { days: week(short) }.validate(),
        Err(ScheduleRefusal::BreakBelowMinimum)
    );
    // 4h30 of work with no break at all.
    let none = work(540, 810, &[]);
    assert_eq!(
        PatternSpec::Weekly { days: week(none) }.validate(),
        Err(ScheduleRefusal::BreakBelowMinimum)
    );
    // 3h59 needs none.
    assert!(
        PatternSpec::Weekly {
            days: week(work(540, 779, &[]))
        }
        .validate()
        .is_ok()
    );
}

#[test]
fn a_day_over_8_hours_and_a_week_over_40_are_refused() {
    let long = work(480, 1140, &[(720, 780)]); // 10h of work
    assert_eq!(
        PatternSpec::Weekly { days: week(long) }.validate(),
        Err(ScheduleRefusal::DailyHoursOver8)
    );
    let mut six = vec![office(); 6];
    six.push(DaySpec::WeeklyHoliday);
    assert_eq!(
        PatternSpec::Weekly { days: six }.validate(),
        Err(ScheduleRefusal::WeeklyHoursOver40)
    );
}

#[test]
fn a_week_without_a_weekly_holiday_is_refused() {
    let mut days = vec![office(); 5];
    days.extend([DaySpec::RestDay, DaySpec::RestDay]);
    assert_eq!(
        PatternSpec::Weekly { days }.validate(),
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
            .validate(),
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
    let d = spec.validate().unwrap();
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
    assert!(ok.validate().is_ok());
    for choices in [vec![480, 600], vec![540, 540], vec![540]] {
        let spec = PatternSpec::Staggered {
            days: week(office()),
            start_choices: choices.clone(),
        };
        assert_eq!(
            spec.validate(),
            Err(ScheduleRefusal::StartChoiceInvalid),
            "{choices:?}"
        );
    }
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
