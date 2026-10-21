//! A write into a reopened month orders against an in-flight re-lock: it waits for
//! the payroll lock key and then sees the month closed (att-closed-month-unlock).

use console_attendance_domain::schedule::Level;
use time::{Duration, OffsetDateTime};

use super::closed_month::{DAY, cells_refused, lock_september, unlock};
use super::save::{cell, save, scheduled};
use super::support::{World, assign, code, key, office};

/// A re-lock that holds the payroll key and has written its row, uncommitted.
async fn relock_in_flight(w: &World) -> sqlx::Transaction<'static, sqlx::Postgres> {
    let mut relock = w.owner.begin().await.unwrap();
    console_platform_db::lock_period_lock_key(
        &mut relock,
        console_platform_db::PeriodLockDomain::Payroll,
        w.org,
    )
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO period_locks (org_id, domain, period_start, period_end, reason) \
         VALUES ($1, 'payroll', DATE '2026-09-01', DATE '2026-09-30', 'relock')",
    )
    .bind(w.org)
    .execute(&mut *relock)
    .await
    .unwrap();
    relock
}

/// Until PostgreSQL shows a session waiting on an advisory lock.
async fn until_waiting(w: &World) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let waiting: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
        )
        .fetch_one(&w.owner)
        .await
        .unwrap();
        if waiting > 0 {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the write must wait for the re-lock's payroll key"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

async fn reopened_september(w: &World) {
    let lock = lock_september(w).await;
    sqlx::query("INSERT INTO attendance_month_closes (org_id, month, checks, attested_by, period_lock_id) VALUES ($1, '2026-09-01', '{}', $2, $3)")
        .bind(w.org).bind(w.admin).bind(lock).execute(&w.owner).await.unwrap();
    unlock(w, lock, OffsetDateTime::now_utc() + Duration::hours(1)).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_write_into_a_reopened_month_orders_against_the_relock(owner: sqlx::PgPool) {
    let w = scheduled(owner).await;
    reopened_september(&w).await;
    let relock = relock_in_flight(&w).await;
    let (store, hr, c) = (w.store.clone(), w.hr(), cell(&w, 0, DAY, "9-18"));
    let write = tokio::spawn(async move { store.save_entries(&hr, &key(), save(vec![c])).await });
    until_waiting(&w).await;
    assert!(!write.is_finished());
    relock.commit().await.unwrap();
    assert_eq!(
        cells_refused(write.await.unwrap()),
        vec!["entry_month_closed"],
        "the write ordered after the re-lock sees the month closed"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_schedule_into_a_reopened_month_orders_against_the_relock(owner: sqlx::PgPool) {
    let w = scheduled(owner).await;
    let (pattern, _) = w
        .store
        .create_pattern(&w.hr(), &key(), office("야간"))
        .await
        .unwrap();
    reopened_september(&w).await;
    let relock = relock_in_flight(&w).await;
    let (store, hr, workplace) = (w.store.clone(), w.hr(), w.workplaces[0]);
    let write = tokio::spawn(async move {
        store
            .assign_schedule(
                &hr,
                &key(),
                assign(Level::Workplace, workplace, pattern.id, DAY),
            )
            .await
    });
    until_waiting(&w).await;
    assert!(!write.is_finished());
    relock.commit().await.unwrap();
    assert_eq!(code(write.await.unwrap()), "schedule_month_closed");
}
