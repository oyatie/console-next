// SPDX-License-Identifier: LicenseRef-Proprietary
use time::{Date, macros::date};

use super::break_floor::{BreakFloorFinding, deducted_break_minutes};
use super::{BreakFloorRow, Shift, Window};

pub(super) fn floor_on() -> Date {
    date!(2026 - 10 - 20)
}

pub(super) fn korea_floors() -> Vec<BreakFloorRow> {
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

pub(super) fn w(start: u16, end: u16) -> Window {
    Window { start, end }
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
