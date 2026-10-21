//! A closed 근태 month refuses writes; an approved period unlock reopens it for
//! its window and a re-lock closes it again (att-closed-month-unlock).

use console_attendance_adapter_postgres::{BoardQuery, GridQuery, ScheduleStoreError};
use console_attendance_application::records::UndoInput;
use console_attendance_domain::close::MonthState;
use console_attendance_domain::schedule::Level;
use console_platform_db::period_lock::{UnlockWrite, unlock_in_tx};
use time::macros::date;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use super::save::{cell, save, scheduled};
use super::support::{World, assign, code, key, office};

pub const DAY: time::Date = date!(2026 - 09 - 15);

pub fn cells_refused<T: std::fmt::Debug>(r: Result<T, ScheduleStoreError>) -> Vec<&'static str> {
    match r {
        Err(ScheduleStoreError::CellsRefused(cells)) => {
            cells.into_iter().map(|c| c.code.unwrap()).collect()
        }
        other => panic!("expected cells_refused, got {other:?}"),
    }
}

pub async fn lock_september(w: &World) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO period_locks (org_id, domain, period_start, period_end, reason, locked_by) \
         VALUES ($1, 'payroll', DATE '2026-09-01', DATE '2026-09-30', 'attendance close 2026-09', $2) RETURNING id",
    )
    .bind(w.org)
    .bind(w.admin)
    .fetch_one(&w.owner)
    .await
    .unwrap()
}

/// The governed unlock as `POST /period-locks/{id}/unlock[/approve]` performs
/// it, committed in its own org-armed transaction.
pub async fn unlock(w: &World, lock: Uuid, relock_at: OffsetDateTime) {
    let mut tx = w.owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(w.org.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    unlock_in_tx(
        &mut tx,
        lock,
        &UnlockWrite {
            unlocked_by: w.admin,
            approved_by: None,
            step_up_assertion_id: Uuid::new_v4(),
            reason_code: "RETRO_CORRECTION",
            note: Some("소급 정정"),
            relock_at,
            review_required: true,
        },
    )
    .await
    .unwrap();
    tx.commit()
        .await
        .expect("the governed unlock of a lock behind an org close commits");
}

async fn state(w: &World) -> (MonthState, MonthState, MonthState, bool) {
    let hr = w.hr();
    let month = w
        .store
        .person_month(&hr, w.people[0], "2026-09".into())
        .await
        .unwrap();
    let grid = w
        .store
        .month_grid(
            &hr,
            GridQuery {
                month: "2026-09".into(),
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
    let board = w
        .store
        .day_board(
            &hr,
            BoardQuery {
                date: Some(DAY),
                unit_id: Some(w.team),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let board_row = board
        .groups
        .iter()
        .flat_map(|g| &g.rows)
        .find(|r| r.employee_id == w.people[0])
        .unwrap();
    (
        month.month_state,
        row.month_state,
        board_row.month_state,
        month.provisional,
    )
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_approved_unlock_reopens_a_closed_month_until_it_relocks(owner: sqlx::PgPool) {
    let w = scheduled(owner).await;
    let hr = w.hr();
    let (before, _) = w
        .store
        .save_entries(&hr, &key(), save(vec![cell(&w, 0, DAY, "9-18")]))
        .await
        .unwrap();
    let lock = lock_september(&w).await;
    sqlx::query("INSERT INTO attendance_month_closes (org_id, month, checks, attested_by, period_lock_id) VALUES ($1, '2026-09-01', '{}', $2, $3)")
        .bind(w.org).bind(w.admin).bind(lock).execute(&w.owner).await.unwrap();

    // Closed: every write path refuses, and every read says so with the lock to unlock.
    let closed = MonthState::Closed {
        lock_id: Some(lock),
    };
    assert_eq!(state(&w).await, (closed, closed, closed, false));
    assert_eq!(
        cells_refused(
            w.store
                .save_entries(&hr, &key(), save(vec![cell(&w, 0, DAY, "8-17")]))
                .await
        ),
        vec!["entry_month_closed"]
    );
    let undo = || UndoInput {
        reason: "잘못 입력".into(),
    };
    assert_eq!(
        code(w.store.undo_batch(&hr, before.batch_id, undo()).await),
        "batch_month_closed"
    );

    // Reopened by the approved unlock: writes are taken until relock_at.
    let relock_at = OffsetDateTime::now_utc() + Duration::hours(4);
    unlock(&w, lock, relock_at).await;
    let (month, row, board, provisional) = state(&w).await;
    let MonthState::Reopened {
        lock_id,
        relock_at: Some(at),
    } = month
    else {
        panic!("expected reopened, got {month:?}");
    };
    assert_eq!(lock_id, lock);
    assert_eq!(at.unix_timestamp(), relock_at.unix_timestamp());
    assert_eq!((row, board, provisional), (month, month, true));
    let (during, fresh) = w
        .store
        .save_entries(&hr, &key(), save(vec![cell(&w, 1, DAY, "9-18")]))
        .await
        .expect("a reopened month takes the write");
    assert!(fresh);
    w.store
        .undo_batch(&hr, before.batch_id, undo())
        .await
        .expect("a reopened month takes the 일괄 취소");

    // Re-locked early (a new lock over the same window): closed again.
    let relocked = lock_september(&w).await;
    let closed = MonthState::Closed {
        lock_id: Some(relocked),
    };
    assert_eq!(state(&w).await, (closed, closed, closed, false));
    assert_eq!(
        cells_refused(
            w.store
                .save_entries(&hr, &key(), save(vec![cell(&w, 0, DAY, "8-17")]))
                .await
        ),
        vec!["entry_month_closed"]
    );
    assert_eq!(
        code(w.store.undo_batch(&hr, during.batch_id, undo()).await),
        "batch_month_closed"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_unlock_window_that_has_passed_closes_the_month_without_the_scheduler(
    owner: sqlx::PgPool,
) {
    let w = scheduled(owner).await;
    let lock = lock_september(&w).await;
    sqlx::query("INSERT INTO attendance_month_closes (org_id, month, checks, attested_by, period_lock_id) VALUES ($1, '2026-09-01', '{}', $2, $3)")
        .bind(w.org).bind(w.admin).bind(lock).execute(&w.owner).await.unwrap();
    unlock(&w, lock, OffsetDateTime::now_utc() + Duration::seconds(2)).await;
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    assert_eq!(
        state(&w).await.0,
        MonthState::Closed {
            lock_id: Some(lock)
        },
        "the expired window is in force before the re-lock row exists"
    );
    assert_eq!(
        cells_refused(
            w.store
                .save_entries(&w.hr(), &key(), save(vec![cell(&w, 0, DAY, "9-18")]))
                .await
        ),
        vec!["entry_month_closed"]
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_branch_close_is_reopened_by_the_month_unlock_and_without_a_lock_has_none(
    owner: sqlx::PgPool,
) {
    let w = scheduled(owner).await;
    sqlx::query("INSERT INTO attendance_month_closes (org_id, month, branch_id, checks, attested_by) VALUES ($1, '2026-09-01', $2, '{}', $3)")
        .bind(w.org).bind(w.branches[0]).bind(w.admin).execute(&w.owner).await.unwrap();
    assert_eq!(state(&w).await.0, MonthState::Closed { lock_id: None });
    let (pattern, _) = w
        .store
        .create_pattern(&w.hr(), &key(), office("야간"))
        .await
        .unwrap();
    let schedule_refusals = async || {
        w.store
            .preview_schedule(
                &w.hr(),
                assign(Level::Workplace, w.workplaces[0], pattern.id, DAY),
            )
            .await
            .unwrap()
            .refusals
            .into_iter()
            .map(|r| r.code)
            .collect::<Vec<_>>()
    };
    assert!(schedule_refusals().await.contains(&"schedule_month_closed"));
    let lock = lock_september(&w).await;
    unlock(&w, lock, OffsetDateTime::now_utc() + Duration::hours(1)).await;
    assert!(matches!(state(&w).await.0, MonthState::Reopened { lock_id, .. } if lock_id == lock));
    assert!(!schedule_refusals().await.contains(&"schedule_month_closed"));
    w.store
        .save_entries(&w.hr(), &key(), save(vec![cell(&w, 0, DAY, "9-18")]))
        .await
        .expect("the org-wide unlock reaches the branch close");
}
