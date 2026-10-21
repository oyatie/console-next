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
fn early_arrival_and_a_late_stay_stay_recorded_only() {
    // 07:52 – 19:10 with no 승인: 8:00 인정, 8분 early, 2:10 late.
    let r = recognise(&[w(472, 1150)], Some(&factory()), &[]);
    assert_eq!(
        (r.recognised, r.early_unrecognised, r.late_unrecognised),
        (480, 8, 130)
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
    let r = recognise(&[w(480, 1100)], Some(&factory()), &[w(1020, 1140)]);
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
fn approved_work_through_lunch_counts_and_an_unapproved_lunch_does_not() {
    let through = recognise(&[w(480, 1020)], Some(&factory()), &[w(720, 780)]);
    assert_eq!((through.recognised, through.approved), (540, 60));
    let plain = recognise(&[w(480, 1020)], Some(&factory()), &[]);
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
    let r = recognise(&[w(490, 660), w(810, 990)], Some(&factory()), &[]);
    assert_eq!((r.late_in, r.away, r.early_out), (10, 60 + 30, 30));
    assert_eq!(r.recognised, 480 - 10 - 90 - 30);
}

#[test]
fn no_schedule_recognises_nothing_but_approved_time() {
    let none = recognise(&[w(540, 1080)], None, &[]);
    assert_eq!((none.recognised, none.recorded), (0, 540));
    let holiday = recognise(&[w(540, 1080)], None, &[w(540, 720), w(780, 1080)]);
    assert_eq!(holiday.recognised, 480);
}

#[test]
fn a_night_shift_crosses_midnight() {
    let night = Shift {
        start: 1320,
        end: 1860,
        breaks: vec![w(1560, 1620)],
    };
    let r = recognise(&[w(1310, 1870)], Some(&night), &[]);
    assert_eq!(
        (r.recognised, r.early_unrecognised, r.late_unrecognised),
        (480, 10, 10)
    );
}
