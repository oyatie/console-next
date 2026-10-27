// SPDX-License-Identifier: LicenseRef-Proprietary
//! The paid-time rule reaches preview, both grids and the day board.
use console_attendance_adapter_postgres::{BoardQuery, GridQuery};
use console_attendance_application::records::PreviewInput;
use console_attendance_application::records_read::RecognitionRead;
use console_attendance_domain::records::Mark;
use sqlx::PgPool;
use time::macros::date;

use super::save::{cell, save, scheduled};
use super::support::key;

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
    paid(preview.cells[0].after.as_ref().unwrap().recognition);
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
    paid(
        month
            .days
            .iter()
            .find(|d| d.date == date)
            .unwrap()
            .recognition,
    );
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
    paid(
        rows.iter()
            .find(|r| r.employee_id == w.people[0])
            .unwrap()
            .day
            .recognition,
    );
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
