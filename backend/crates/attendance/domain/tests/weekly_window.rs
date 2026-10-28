// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use console_attendance_domain::{
    StrictDurationEvent, StrictDurationEventKind, StrictDurationWindow, strict_pair_seconds,
};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

#[test]
fn complete_pairs_wholly_outside_the_requested_week_contribute_zero() {
    let at = OffsetDateTime::UNIX_EPOCH;
    let window =
        StrictDurationWindow::new(at + Duration::days(7), at + Duration::days(14)).unwrap();
    for start in [at, at + Duration::days(15)] {
        let events = [
            StrictDurationEvent {
                id: Uuid::from_u128(1),
                employee_id: Uuid::nil(),
                kind: StrictDurationEventKind::ClockIn,
                occurred_at: start,
            },
            StrictDurationEvent {
                id: Uuid::from_u128(2),
                employee_id: Uuid::nil(),
                kind: StrictDurationEventKind::ClockOut,
                occurred_at: start + Duration::hours(9),
            },
        ];
        assert!(strict_pair_seconds(&events, window).unwrap().is_empty());
    }
}
