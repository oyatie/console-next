// SPDX-License-Identifier: LicenseRef-Proprietary
//! The paid-time rule reaches preview, both grids and the day board.
use console_attendance_adapter_postgres::{BoardQuery, GridQuery};
use console_attendance_application::records::PreviewInput;
use console_attendance_application::records_read::{DayRead, RecognitionRead};
use console_attendance_domain::records::{IntervalCategory, IntervalReason, Mark};
use sqlx::PgPool;
use time::macros::date;

use super::save::{cell, save, scheduled};
use super::support::{TestReads, key};

fn paid(r: RecognitionRead) {
    assert_eq!(
        (r.recognised, r.regular, r.outside_scheduled),
        (600, 480, 120)
    );
    assert_eq!(
        (r.prior_approved, r.post_approved, r.excess_open, r.not_work),
        (0, 0, 120, 0)
    );
    assert_eq!(
        (r.approved, r.early_unrecognised, r.late_unrecognised),
        (0, 0, 120)
    );
    assert!(!r.over_cap);
}

fn intervals(day: &DayRead) -> Vec<(u16, u16, u32, IntervalCategory, bool, IntervalReason)> {
    day.intervals
        .iter()
        .map(|i| {
            (
                i.start,
                i.end,
                i.minutes,
                i.category,
                i.recognised,
                i.reason_code,
            )
        })
        .collect()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn worked_time_is_paid_on_every_projection_without_approval(owner: PgPool) {
    let w = scheduled(owner).await;
    let date = date!(2026 - 10 - 06);
    let preview = w
        .store
        .preview_entries(
            &w.hr(),
            PreviewInput {
                cells: vec![cell(&w, 0, date, "9-20")],
            },
        )
        .await
        .unwrap();
    let preview_day = preview.cells[0].after.as_ref().unwrap();
    paid(preview_day.recognition);
    assert_eq!(
        intervals(preview_day),
        vec![
            (
                540,
                720,
                180,
                IntervalCategory::Work,
                true,
                IntervalReason::ScheduledWork
            ),
            (
                720,
                780,
                60,
                IntervalCategory::Break,
                false,
                IntervalReason::ScheduledBreak
            ),
            (
                780,
                1080,
                300,
                IntervalCategory::Work,
                true,
                IntervalReason::ScheduledWork
            ),
            (
                1080,
                1200,
                120,
                IntervalCategory::Overtime,
                true,
                IntervalReason::OpenOvertime
            ),
        ]
    );
    w.store
        .save_entries(
            &w.hr(),
            &key(),
            save(vec![
                cell(&w, 0, date, "9-20"),
                cell(&w, 0, date!(2026 - 10 - 04), "9-18"),
                cell(&w, 2, date, "9-18"),
            ]),
        )
        .await
        .unwrap();
    let grid = w
        .store
        .month_grid(
            &w.hr(),
            GridQuery {
                month: "2026-10".into(),
                limit: 100,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let row = grid
        .rows
        .iter()
        .find(|r| r.employee_id == w.people[0])
        .unwrap();
    assert_eq!(
        row.cells
            .iter()
            .find(|c| c.date == date)
            .unwrap()
            .recognised,
        600
    );
    assert_eq!(
        (row.totals.recognised, row.totals.outside_scheduled),
        (1140, 660)
    );
    let month = w
        .store
        .person_month(&w.hr(), w.people[0], "2026-10".into())
        .await
        .unwrap();
    let month_day = month.days.iter().find(|d| d.date == date).unwrap();
    paid(month_day.recognition);
    assert_eq!(intervals(month_day), intervals(preview_day));
    let rest = month
        .days
        .iter()
        .find(|d| d.date == date!(2026 - 10 - 04))
        .unwrap();
    assert_eq!(rest.recognition.recognised, 540);
    assert_eq!(rest.marks, vec![Mark::WorkOnRestDay]);
    let board = w
        .store
        .day_board(
            &w.hr(),
            BoardQuery {
                date: Some(date),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let rows: Vec<_> = board.groups.iter().flat_map(|g| &g.rows).collect();
    let board_day = &rows
        .iter()
        .find(|r| r.employee_id == w.people[0])
        .unwrap()
        .day;
    paid(board_day.recognition);
    assert_eq!(intervals(board_day), intervals(preview_day));
    let unplanned = rows.iter().find(|r| r.employee_id == w.people[2]).unwrap();
    assert_eq!(
        (
            unplanned.day.recognition.recognised,
            unplanned.day.recognition.regular
        ),
        (540, 0)
    );
    assert_eq!(
        (
            unplanned.day.recognition.outside_scheduled,
            unplanned.day.recognition.excess_open
        ),
        (0, 0)
    );
    assert_eq!(unplanned.day.marks, vec![Mark::NoSchedule]);
    // Before-count evaluates the stored day through the same rule; editing it
    // keeps one decision instead of silently dropping paid excess.
    let mut changed = cell(&w, 0, date, "9-19");
    changed.base_entry_id = month
        .days
        .iter()
        .find(|d| d.date == date)
        .unwrap()
        .entry
        .as_ref()
        .map(|e| e.id);
    let next = w
        .store
        .preview_entries(
            &w.hr(),
            PreviewInput {
                cells: vec![changed],
            },
        )
        .await
        .unwrap();
    assert_eq!(
        next.cells[0].after.as_ref().unwrap().recognition.recognised,
        540
    );
    assert_eq!(next.closes.decision, 0);
}
