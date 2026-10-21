//! 정정, 기록 취소 then 재기록, and 일괄 취소, each with its refusals.

use console_attendance_adapter_postgres::GridQuery;
use console_attendance_application::records::{CorrectInput, UndoInput, VoidInput};
use sqlx::PgPool;
use time::macros::date;
use uuid::Uuid;

use super::save::{cell, paper, save, scheduled};
use super::support::{code, key};

const TUE: time::Date = date!(2026 - 10 - 06);

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_correction_keeps_both_values_and_a_void_can_be_restored(owner: PgPool) {
    let w = scheduled(owner).await;
    let hr = w.hr();
    w.store
        .save_entries(&hr, &key(), save(vec![cell(&w, 0, TUE, "9-21:47")]))
        .await
        .unwrap();
    let first = w
        .store
        .person_month(&hr, w.people[0], "2026-10".into())
        .await
        .unwrap()
        .history[0]
        .entry
        .id;
    let fix = |v: &str| CorrectInput {
        long_span_confirmed: false,
        value: v.into(),
        reason: "출근부와 대조".into(),
        evidence: paper(),
    };
    let blank = CorrectInput {
        long_span_confirmed: false,
        value: "9-17:06".into(),
        reason: " ".into(),
        evidence: paper(),
    };
    assert_eq!(
        code(w.store.correct_entry(&hr, &key(), first, blank).await),
        "reason_required"
    );
    assert_eq!(
        code(
            w.store
                .correct_entry(&hr, &key(), Uuid::new_v4(), fix("9-18"))
                .await
        ),
        "entry_not_found"
    );
    w.store
        .correct_entry(&hr, &key(), first, fix("9-17:06"))
        .await
        .unwrap();
    assert_eq!(
        code(w.store.correct_entry(&hr, &key(), first, fix("9-18")).await),
        "entry_superseded"
    );
    let month = w
        .store
        .person_month(&hr, w.people[0], "2026-10".into())
        .await
        .unwrap();
    assert_eq!(month.history.len(), 2);
    assert_eq!(month.history[0].entry.supersedes_id, Some(first));
    let current = month.history[0].entry.id;

    let void = VoidInput {
        reason: "다른 사람 기록".into(),
        evidence: paper(),
    };
    w.store
        .void_entry(&hr, &key(), current, void)
        .await
        .unwrap();
    let day = |g: &console_attendance_application::records_read::MonthGrid| {
        g.rows
            .iter()
            .find(|r| r.employee_id == w.people[0])
            .unwrap()
            .cells
            .iter()
            .find(|c| c.date == TUE)
            .unwrap()
            .clone()
    };
    let grid = w
        .store
        .month_grid(
            &hr,
            GridQuery {
                month: "2026-10".into(),
                limit: 100,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let voided = day(&grid);
    assert!(
        voided.entry_kind.is_none() && voided.entry_id.is_some(),
        "empty again, its history kept"
    );
    // 재기록: the next save names the void as its base.
    let mut again = cell(&w, 0, TUE, "9-18");
    again.base_entry_id = voided.entry_id;
    w.store
        .save_entries(&hr, &key(), save(vec![again]))
        .await
        .unwrap();
    let grid = w
        .store
        .month_grid(
            &hr,
            GridQuery {
                month: "2026-10".into(),
                limit: 100,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(day(&grid).recognised, 480);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_undone_batch_stops_counting_until_its_month_closes(owner: PgPool) {
    let w = scheduled(owner).await;
    let hr = w.hr();
    let (r, _) = w
        .store
        .save_entries(
            &hr,
            &key(),
            save(vec![cell(&w, 0, TUE, "9-18"), cell(&w, 1, TUE, "9-18")]),
        )
        .await
        .unwrap();
    let undo = || UndoInput {
        reason: "잘못된 사업장 출근부".into(),
    };
    assert_eq!(
        code(
            w.store
                .undo_batch(
                    &hr,
                    r.batch_id,
                    UndoInput {
                        reason: String::new()
                    }
                )
                .await
        ),
        "reason_required"
    );
    assert_eq!(
        code(w.store.undo_batch(&hr, Uuid::new_v4(), undo()).await),
        "batch_not_found"
    );
    w.store.undo_batch(&hr, r.batch_id, undo()).await.unwrap();
    assert_eq!(
        code(w.store.undo_batch(&hr, r.batch_id, undo()).await),
        "batch_already_undone"
    );
    let grid = w
        .store
        .month_grid(
            &hr,
            GridQuery {
                month: "2026-10".into(),
                limit: 100,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(
        grid.rows
            .iter()
            .all(|row| row.cells.iter().all(|c| c.entry_id.is_none()))
    );

    let (r2, _) = w
        .store
        .save_entries(
            &hr,
            &key(),
            save(vec![cell(&w, 0, date!(2026 - 09 - 15), "9-18")]),
        )
        .await
        .unwrap();
    sqlx::query("INSERT INTO attendance_month_closes (org_id, month, branch_id, checks, attested_by) VALUES ($1, '2026-09-01', $2, '{}', $3)")
        .bind(w.org).bind(w.branches[0]).bind(w.admin).execute(&w.owner).await.unwrap();
    assert_eq!(
        code(w.store.undo_batch(&hr, r2.batch_id, undo()).await),
        "batch_month_closed"
    );
    // The database keeps entries append-only; whether a month takes writes is
    // the domain's decision (closed_month.rs), not a trigger's.
    assert!(
        sqlx::query("DELETE FROM attendance_entries")
            .execute(&w.owner)
            .await
            .is_err()
    );
}
