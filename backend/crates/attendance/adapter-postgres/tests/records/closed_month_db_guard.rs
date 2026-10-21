//! The database's own closed-month guard (`trg_attendance_entries_closed_month`)
//! for a writer that skips the domain rule: it refuses an entry in a closed
//! month, takes it while an approved unlock reopens the month, and refuses it
//! again once the month re-locks, as `console_attendance_domain::close` decides.
//! The kept 0188 guard still refuses an unlock of a lock behind an org close
//! that does not come through the governed `unlock_in_tx` (the previous
//! release's unlock).

use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use super::closed_month::{DAY, lock_september, unlock};
use super::save::scheduled;
use super::support::World;

/// One batch and one entry inserted directly, past the attendance store.
async fn insert_directly(w: &World) -> Result<(), String> {
    let mut tx = w.owner.begin().await.unwrap();
    let batch: Uuid = sqlx::query_scalar(
        "INSERT INTO attendance_batches (org_id, source, evidence_kind, cells, created_by, \
            idempotency_key, request_fingerprint) \
         VALUES ($1, 'MANUAL', 'PAPER_SHEET', 1, $2, $3, repeat('a', 64)) RETURNING id",
    )
    .bind(w.org)
    .bind(w.admin)
    .bind(format!("direct-{}", Uuid::new_v4()))
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let entry = sqlx::query(
        "INSERT INTO attendance_entries (org_id, batch_id, employee_id, work_date, kind, created_by) \
         VALUES ($1, $2, $3, $4, 'ABSENT', $5)",
    )
    .bind(w.org)
    .bind(batch)
    .bind(w.people[0])
    .bind(DAY)
    .bind(w.admin)
    .execute(&mut *tx)
    .await;
    match entry {
        Ok(_) => {
            tx.commit().await.unwrap();
            Ok(())
        }
        Err(sqlx::Error::Database(e)) => Err(e.code().unwrap_or_default().into_owned()),
        Err(e) => panic!("unexpected error: {e}"),
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_direct_write_into_a_closed_month_is_refused_unless_an_unlock_reopens_it(
    owner: sqlx::PgPool,
) {
    let w = scheduled(owner).await;
    insert_directly(&w)
        .await
        .expect("an open month takes the write");

    let lock = lock_september(&w).await;
    sqlx::query("INSERT INTO attendance_month_closes (org_id, month, checks, attested_by, period_lock_id) VALUES ($1, '2026-09-01', '{}', $2, $3)")
        .bind(w.org).bind(w.admin).bind(lock).execute(&w.owner).await.unwrap();
    assert_eq!(
        insert_directly(&w).await,
        Err("25006".to_owned()),
        "closed, lock in force"
    );

    unlock(&w, lock, OffsetDateTime::now_utc() + Duration::hours(4)).await;
    insert_directly(&w)
        .await
        .expect("the approved unlock reopens the month for the database guard too");

    lock_september(&w).await;
    assert_eq!(
        insert_directly(&w).await,
        Err("25006".to_owned()),
        "re-locked"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_direct_write_into_a_branch_closed_month_with_no_lock_is_refused(owner: sqlx::PgPool) {
    let w = scheduled(owner).await;
    // people[0] works at 평택 (branches[0]); a close of the other branch does not reach them.
    for (branch, refused) in [(w.branches[1], false), (w.branches[0], true)] {
        sqlx::query("INSERT INTO attendance_month_closes (org_id, month, branch_id, checks, attested_by) VALUES ($1, '2026-09-01', $2, '{}', $3)")
            .bind(w.org).bind(branch).bind(w.admin).execute(&w.owner).await.unwrap();
        let expected = if refused {
            Err("25006".to_owned())
        } else {
            Ok(())
        };
        assert_eq!(insert_directly(&w).await, expected);
    }
}

/// The previous release's unlock: the same UPDATE as `unlock_in_tx`, without
/// naming the row in `app.period_unlock`.
async fn unlock_as_previous_release(w: &World, lock: Uuid) -> Result<(), String> {
    let mut tx = w.owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(w.org.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE period_locks SET unlocked_at = now(), unlocked_by = $2, unlock_reason = '소급 정정', \
                unlock_reason_code = 'RETRO_CORRECTION', relock_at = now() + interval '4 hours', \
                unlock_step_up_assertion_id = $3, unlock_review_required = true \
         WHERE id = $1",
    )
    .bind(lock)
    .bind(w.admin)
    .bind(Uuid::new_v4())
    .execute(&mut *tx)
    .await
    .unwrap();
    // The 0188 guard is a deferred constraint trigger: it refuses at COMMIT.
    match tx.commit().await {
        Ok(()) => Ok(()),
        Err(sqlx::Error::Database(e)) => Err(e.code().unwrap_or_default().into_owned()),
        Err(e) => panic!("unexpected error: {e}"),
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_unlock_that_skips_the_governed_path_of_a_lock_behind_an_org_close_is_refused(
    owner: sqlx::PgPool,
) {
    let w = scheduled(owner).await;
    let lock = lock_september(&w).await;
    sqlx::query("INSERT INTO attendance_month_closes (org_id, month, checks, attested_by, period_lock_id) VALUES ($1, '2026-09-01', '{}', $2, $3)")
        .bind(w.org).bind(w.admin).bind(lock).execute(&w.owner).await.unwrap();

    assert_eq!(
        unlock_as_previous_release(&w, lock).await,
        Err("23514".to_owned()),
        "the previous release's unlock stays refused"
    );
    assert_eq!(
        insert_directly(&w).await,
        Err("25006".to_owned()),
        "and the month stays closed"
    );

    unlock(&w, lock, OffsetDateTime::now_utc() + Duration::hours(4)).await;
    insert_directly(&w)
        .await
        .expect("the governed unlock reopens it");
}
