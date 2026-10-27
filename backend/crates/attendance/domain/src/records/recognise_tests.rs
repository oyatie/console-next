use super::*;

fn w(start: u16, end: u16) -> Window {
    Window { start, end }
}
/// 08:00–17:00, 휴게 12:00–13:00.
fn factory() -> Shift {
    Shift {
        start: 480,
        end: 1020,
        breaks: vec![w(720, 780)],
    }
}

#[test]
fn early_arrival_and_a_late_stay_are_paid_without_approval() {
    // Recorded work is paid, including 8 early minutes and 2:10 after the shift.
    let r = recognise(
        &[w(472, 1150)],
        Some(&factory()),
        DayKind::Work,
        &[],
        &[],
        &[],
    );
    assert_eq!(
        (r.recognised, r.early_unrecognised, r.late_unrecognised),
        (618, 8, 130)
    );
    assert_eq!(
        (r.late_in, r.early_out, r.away, r.approval_unused),
        (0, 0, 0, 0)
    );
    assert_eq!(r.recorded, 678);
}

#[test]
fn an_approved_window_is_recognised_only_where_worked() {
    // 승인 17:00–19:00, worked until 18:20: 1:20 approved, 0:40 unused.
    let r = recognise(
        &[w(480, 1100)],
        Some(&factory()),
        DayKind::Work,
        &[w(1020, 1140)],
        &[],
        &[],
    );
    assert_eq!(
        (
            r.regular,
            r.approved,
            r.approval_unused,
            r.late_unrecognised
        ),
        (480, 80, 40, 0)
    );
}

#[test]
fn approval_cannot_turn_a_scheduled_break_into_work() {
    let through = recognise(
        &[w(480, 1020)],
        Some(&factory()),
        DayKind::Work,
        &[w(720, 780)],
        &[],
        &[],
    );
    assert_eq!((through.recognised, through.approved), (480, 0));
    let plain = recognise(
        &[w(480, 1020)],
        Some(&factory()),
        DayKind::Work,
        &[],
        &[],
        &[],
    );
    assert_eq!(
        (
            plain.recognised,
            plain.late_unrecognised + plain.early_unrecognised
        ),
        (480, 0)
    );
}

#[test]
fn not_worked_splits_into_late_in_early_out_and_away() {
    // 08:10 – 11:00, 13:30 – 16:30.
    let r = recognise(
        &[w(490, 660), w(810, 990)],
        Some(&factory()),
        DayKind::Work,
        &[],
        &[],
        &[],
    );
    assert_eq!((r.late_in, r.away, r.early_out), (10, 60 + 30, 30));
    assert_eq!(r.recognised, 480 - 10 - 90 - 30);
}

#[test]
fn no_schedule_work_is_paid_without_guessing_a_shift() {
    let none = recognise(&[w(540, 1080)], None, DayKind::NoSchedule, &[], &[], &[]);
    assert_eq!((none.recognised, none.recorded), (540, 540));
    assert_eq!(
        (none.regular, none.outside_scheduled, none.excess_open),
        (0, 0, 0),
        "a missing schedule cannot classify time as regular or excess"
    );
    let holiday = recognise(
        &[w(540, 1080)],
        None,
        DayKind::WeeklyHoliday,
        &[w(540, 720), w(780, 1080)],
        &[],
        &[],
    );
    assert_eq!(holiday.recognised, 540);
}

#[test]
fn a_night_shift_crosses_midnight() {
    let night = Shift {
        start: 1320,
        end: 1860,
        breaks: vec![w(1560, 1620)],
    };
    let r = recognise(&[w(1310, 1870)], Some(&night), DayKind::Work, &[], &[], &[]);
    assert_eq!(
        (r.recognised, r.early_unrecognised, r.late_unrecognised),
        (500, 10, 10)
    );
}

#[test]
fn two_unapproved_hours_are_paid_on_top_of_regular_work() {
    let shift = Shift {
        start: 540,
        end: 1080,
        breaks: vec![w(720, 780)],
    };
    let r = recognise(&[w(540, 1200)], Some(&shift), DayKind::Work, &[], &[], &[]);
    assert_eq!((r.recognised, r.regular), (600, 480));
}

#[test]
fn approvals_classify_only_paid_excess_without_double_counting() {
    let shift = factory();
    let r = recognise(
        &[w(480, 1200)],
        Some(&shift),
        DayKind::Work,
        &[w(1020, 1140)],
        &[w(1080, 1170)],
        &[],
    );
    assert_eq!(
        (r.recognised, r.regular, r.outside_scheduled),
        (660, 480, 180)
    );
    assert_eq!(
        (r.prior_approved, r.post_approved, r.excess_open, r.approved),
        (120, 30, 30, 150)
    );
}

#[test]
fn confirmed_non_work_excludes_only_recorded_minutes_outside_breaks() {
    let shift = Shift {
        start: 540,
        end: 1080,
        breaks: vec![w(720, 780)],
    };
    let r = recognise(
        &[w(540, 1200)],
        Some(&shift),
        DayKind::Work,
        &[w(1080, 1200)],
        &[],
        &[w(720, 780), w(1080, 1260)],
    );
    assert_eq!((r.recognised, r.not_work, r.regular), (480, 120, 480));
    assert_eq!(
        (r.outside_scheduled, r.prior_approved, r.excess_open),
        (0, 0, 0)
    );
    assert!(!r.over_cap);
}

#[test]
fn holiday_shift_keeps_breaks_but_no_regular_minutes() {
    let shift = factory();
    let r = recognise(
        &[w(480, 1020)],
        Some(&shift),
        DayKind::PublicHoliday,
        &[],
        &[],
        &[],
    );
    assert_eq!((r.recognised, r.regular, r.excess_open), (480, 0, 480));
}

#[test]
fn five_early_minutes_remain_a_decision_below_the_notice_threshold() {
    use super::super::{Mark, Recorded, Thresholds, marks};
    use crate::schedule::DayKind;
    let r = recognise(
        &[w(475, 1020)],
        Some(&factory()),
        DayKind::Work,
        &[],
        &[],
        &[],
    );
    assert_eq!((r.recognised, r.excess_open), (485, 5));
    assert_eq!(
        marks(
            DayKind::Work,
            false,
            Recorded::Times,
            &r,
            true,
            Thresholds {
                notice_minutes: 10,
                ..Default::default()
            }
        ),
        vec![Mark::UnapprovedExcess]
    );
}

#[test]
fn holiday_evaluation_retains_shift_breaks_and_requires_disposition() {
    use super::super::{EntryKind, Mark, Thresholds, evaluate, marks};
    use crate::schedule::{DayKind, DayPlan};
    let plan = DayPlan {
        kind: DayKind::PublicHoliday,
        shift: Some(factory()),
        holiday_work: true,
        slot_code: None,
        holiday_name: None,
    };
    let (recorded, r) = evaluate(&plan, Some(EntryKind::Times), &[w(480, 1020)], &[]);
    assert_eq!((r.recognised, r.regular, r.excess_open), (480, 0, 480));
    assert_eq!(
        marks(plan.kind, true, recorded, &r, true, Thresholds::default()),
        vec![Mark::WorkOnRestDay]
    );
}
