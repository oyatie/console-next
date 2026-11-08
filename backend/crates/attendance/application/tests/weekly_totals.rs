// SPDX-License-Identifier: LicenseRef-Proprietary
use console_attendance_application::week52::approved_day_hours;
use console_attendance_domain::records::Recognition;

#[test]
fn only_approved_worked_excess_counts_towards_weekly_totals() {
    let r = Recognition {
        regular: 480,
        outside_scheduled: 120,
        ..Recognition::default()
    };
    for (approved, expected) in [
        (Some(0.0), Some((8.0, 0.0))),
        (Some(1.25), Some((9.25, 1.25))),
        (Some(9.0), Some((10.0, 2.0))),
        (None, None),
        (Some(-1.0), None),
        (Some(f64::NAN), None),
        (Some(f64::INFINITY), None),
    ] {
        assert_eq!(approved_day_hours(&r, approved), expected);
    }
}
