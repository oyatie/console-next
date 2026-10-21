use super::*;
use crate::schedule::{DaySpec, PatternSpec, Shift, Slot, Window};
use time::macros::date;

fn layer(level: Level, depth: u8, from: Date, to: Option<Date>, version: i32) -> LayerRef {
    LayerRef {
        id: Uuid::from_u128(
            u128::from(version.unsigned_abs())
                + (u128::from(depth) << 32)
                + ((level as u128) << 40),
        ),
        level,
        depth,
        pattern_id: Uuid::nil(),
        effective_from: from,
        effective_to: to,
        version,
        rotation_start: None,
        start_choice: None,
    }
}

#[test]
fn the_nearest_level_wins_and_the_latest_start_wins_within_it() {
    let entity = layer(Level::LegalEntity, 0, date!(2026 - 01 - 01), None, 1);
    let site = layer(Level::Workplace, 0, date!(2026 - 03 - 01), None, 1);
    let site_v2 = layer(Level::Workplace, 0, date!(2026 - 11 - 01), None, 2);
    let all = [entity.clone(), site.clone(), site_v2.clone()];
    assert_eq!(winner(&all, date!(2026 - 02 - 10)), Some(&entity));
    assert_eq!(winner(&all, date!(2026 - 10 - 31)), Some(&site));
    assert_eq!(winner(&all, date!(2026 - 11 - 01)), Some(&site_v2));
}

#[test]
fn a_parent_department_layer_reaches_a_child_without_its_own() {
    let parent = layer(Level::Department, 1, date!(2026 - 01 - 01), None, 1);
    let own = layer(Level::Department, 0, date!(2026 - 06 - 01), None, 1);
    let all = [parent.clone(), own.clone()];
    assert_eq!(winner(&all, date!(2026 - 05 - 31)), Some(&parent));
    assert_eq!(winner(&all, date!(2026 - 06 - 01)), Some(&own));
}

#[test]
fn a_one_day_substitute_layer_ends_and_the_earlier_one_returns() {
    let base = layer(Level::Person, 0, date!(2026 - 01 - 01), None, 1);
    let cover = layer(
        Level::Person,
        0,
        date!(2026 - 10 - 07),
        Some(date!(2026 - 10 - 08)),
        2,
    );
    let all = [base.clone(), cover.clone()];
    assert_eq!(winner(&all, date!(2026 - 10 - 07)), Some(&cover));
    assert_eq!(winner(&all, date!(2026 - 10 - 08)), Some(&base));
}

#[test]
fn nobody_reached_has_no_winner() {
    let future = layer(Level::Workplace, 0, date!(2027 - 01 - 01), None, 1);
    assert_eq!(winner(&[future], date!(2026 - 10 - 07)), None);
}

fn office_week() -> PatternSpec {
    let shift = Shift {
        start: 540,
        end: 1080,
        breaks: vec![Window {
            start: 720,
            end: 780,
        }],
    };
    let mut days = vec![DaySpec::Work { shift }; 5];
    days.extend([DaySpec::RestDay, DaySpec::WeeklyHoliday]);
    PatternSpec::Weekly { days }
}

#[test]
fn a_substitute_holiday_on_a_work_day_is_off_unless_the_pattern_works_holidays() {
    let l = layer(Level::Workplace, 0, date!(2026 - 01 - 01), None, 1);
    let h = HolidayFact {
        name: "개천절 대체공휴일".into(),
        kind: HolidayKind::Substitute,
    };
    let off = plan_day(
        &office_week(),
        HolidayRule::Off,
        &l,
        date!(2026 - 10 - 05),
        Some(&h),
    );
    assert_eq!(
        (off.kind, off.shift.is_none(), off.holiday_work),
        (DayKind::SubstituteHoliday, true, false)
    );
    let on = plan_day(
        &office_week(),
        HolidayRule::Work,
        &l,
        date!(2026 - 10 - 05),
        Some(&h),
    );
    assert_eq!(
        (on.kind, on.shift.is_some(), on.holiday_work),
        (DayKind::SubstituteHoliday, true, true)
    );
    // 10/4 is a Sunday: the pattern's 주휴일.
    let sunday = plan_day(
        &office_week(),
        HolidayRule::Off,
        &l,
        date!(2026 - 10 - 04),
        None,
    );
    assert_eq!(sunday.kind, DayKind::WeeklyHoliday);
}

#[test]
fn a_rotation_counts_from_its_start_in_both_directions() {
    let shift = Shift {
        start: 480,
        end: 1020,
        breaks: vec![Window {
            start: 720,
            end: 780,
        }],
    };
    let spec = PatternSpec::Rotation {
        slots: vec![
            Slot {
                code: "주".into(),
                day: DaySpec::Work { shift },
            },
            Slot {
                code: "비".into(),
                day: DaySpec::RestDay,
            },
            Slot {
                code: "휴".into(),
                day: DaySpec::WeeklyHoliday,
            },
        ],
    };
    let mut l = layer(Level::Crew, 0, date!(2026 - 11 - 01), None, 1);
    l.rotation_start = Some(date!(2026 - 11 - 03));
    let code = |d| {
        plan_day(&spec, HolidayRule::Off, &l, d, None)
            .slot_code
            .unwrap()
    };
    assert_eq!(code(date!(2026 - 11 - 03)), "주");
    assert_eq!(code(date!(2026 - 11 - 04)), "비");
    assert_eq!(code(date!(2026 - 11 - 02)), "휴");
    assert_eq!(code(date!(2026 - 11 - 06)), "주");
}
