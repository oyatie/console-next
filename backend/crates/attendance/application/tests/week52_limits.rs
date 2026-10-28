// SPDX-License-Identifier: LicenseRef-Proprietary
use console_attendance_application::{Week52Input, Week52Limits, Week52Tone, week52_tone};
use time::macros::date;
use uuid::Uuid;

#[test]
fn weekly_tone_uses_supplied_limits_at_both_boundaries() {
    let limits = Week52Limits {
        danger_hours: 50.0,
        warn_hours: 45.0,
    };
    for (current, projected, expected) in [
        (44.0, 44.0, Week52Tone::Ok),
        (44.0, 45.0, Week52Tone::Warn),
        (44.0, 49.5, Week52Tone::Warn),
        (44.0, 50.0, Week52Tone::Danger),
        (50.0, 44.0, Week52Tone::Danger),
    ] {
        let input = Week52Input {
            employee_id: Uuid::nil(),
            week_start: date!(2026 - 10 - 26),
            current_hours: current,
            projected_hours: projected,
            acknowledged_at: None,
        };
        assert_eq!(week52_tone(&input, limits), expected);
    }
}
