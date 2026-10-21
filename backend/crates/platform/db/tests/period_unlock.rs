//! BW-15 unlock writes (migration 0271): a second person performs a requested
//! unlock, a new request supersedes the open one, the DB refuses the requester
//! as their own second person, an unlock of an expired window unlocks a
//! successor row, and the re-lock job appends successors exactly once, also
//! with two runners at once.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_kernel_core::{ErrorKind, OrgId};
use console_platform_db::period_lock::{
    NewUnlockRequest, UnlockWrite, approve_unlock_request_in_tx,
    load_open_unlock_request_for_update, open_unlock_request_in_tx, relock_expired_in_tx,
    unlock_in_tx,
};
use console_platform_db::{DbError, PeriodLockDomain, assert_period_open, with_org_conn};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use time::macros::date;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

async fn setup(owner_pool: &PgPool) -> (PgPool, Uuid, Uuid, Uuid) {
    let org = *OrgId::one().as_uuid();
    sqlx::query(
        "INSERT INTO organizations (id, slug, name) VALUES ($1, 'org-a', 'Org A') \
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(org)
    .execute(owner_pool)
    .await
    .unwrap();
    let mut users = Vec::new();
    for name in ["요청자", "승인자"] {
        users.push(
            sqlx::query_scalar(
                "INSERT INTO users (org_id, display_name, roles) VALUES ($1, $2, ARRAY['ADMIN']) \
                 RETURNING id",
            )
            .bind(org)
            .bind(name)
            .fetch_one(owner_pool)
            .await
            .unwrap(),
        );
    }
    let options = owner_pool.connect_options().as_ref().clone();
    let rt = PgPoolOptions::new()
        .max_connections(2)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_rt").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .unwrap();
    (rt, org, users[0], users[1])
}

/// A June payroll lock; `unlocked_hours_ago` and `relock_in_hours` make it an
/// unlocked row whose window is open (`relock_in_hours > 0`) or expired.
async fn seed_lock(owner_pool: &PgPool, org: Uuid, unlock: Option<(i32, i32)>) -> Uuid {
    let (unlocked, relock) = unlock.unzip();
    sqlx::query_scalar(
        "INSERT INTO period_locks (org_id, domain, period_start, period_end, reason_code, \
                                   locked_at, unlocked_at, unlock_reason_code, relock_at) \
         VALUES ($1, 'payroll', DATE '2026-06-01', DATE '2026-06-30', 'MONTHLY_PAYROLL_CLOSE', \
                 now() - interval '1 day', now() - make_interval(hours => $2), \
                 CASE WHEN $2 IS NULL THEN NULL ELSE 'PAYROLL_ERROR' END, \
                 now() + make_interval(hours => $3)) RETURNING id",
    )
    .bind(org)
    .bind(unlocked)
    .bind(relock)
    .fetch_one(owner_pool)
    .await
    .unwrap()
}

fn write(unlocked_by: Uuid, approved_by: Option<Uuid>) -> UnlockWrite<'static> {
    UnlockWrite {
        unlocked_by,
        approved_by,
        step_up_assertion_id: Uuid::new_v4(),
        reason_code: "PAYROLL_ERROR",
        note: None,
        relock_at: OffsetDateTime::now_utc() + Duration::days(3),
        review_required: approved_by.is_none(),
    }
}

async fn june_open(rt: &PgPool) -> bool {
    with_org_conn::<_, _, DbError>(rt, OrgId::one(), |tx| {
        Box::pin(async move {
            Ok(
                assert_period_open(tx, PeriodLockDomain::Payroll, date!(2026 - 06 - 15))
                    .await
                    .is_ok(),
            )
        })
    })
    .await
    .unwrap()
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn a_second_person_performs_the_requested_unlock(owner_pool: PgPool) {
    let (rt, org, requester, approver) = setup(&owner_pool).await;
    let lock = seed_lock(&owner_pool, org, None).await;
    let relock_at = OffsetDateTime::now_utc() + Duration::days(3);
    let new = move |by| NewUnlockRequest {
        org_id: org,
        lock_id: lock,
        requested_by: by,
        reason_code: "RETRO_CORRECTION",
        reason_note: Some("6월 소급"),
        relock_at,
        step_up_assertion_id: Uuid::new_v4(),
    };

    let (first, superseded) = with_org_conn::<_, _, DbError>(&rt, OrgId::one(), move |tx| {
        Box::pin(async move { Ok(open_unlock_request_in_tx(tx, &new(requester)).await?) })
    })
    .await
    .unwrap();
    assert_eq!(superseded, None);
    let (second, superseded) = with_org_conn::<_, _, DbError>(&rt, OrgId::one(), move |tx| {
        Box::pin(async move { Ok(open_unlock_request_in_tx(tx, &new(requester)).await?) })
    })
    .await
    .unwrap();
    assert_eq!(
        superseded,
        Some(first.id),
        "a new request supersedes the open one"
    );

    // The requester is never their own second person (DB CHECKs); each refusal
    // rolls its transaction back.
    let own = with_org_conn::<_, (), DbError>(&rt, OrgId::one(), move |tx| {
        Box::pin(async move { Ok(approve_unlock_request_in_tx(tx, second.id, requester).await?) })
    })
    .await;
    assert!(
        own.is_err(),
        "the requester cannot approve their own request"
    );
    let self_unlock = with_org_conn::<_, Uuid, DbError>(&rt, OrgId::one(), move |tx| {
        Box::pin(async move {
            unlock_in_tx(tx, lock, &write(requester, Some(requester)))
                .await
                .map_err(|e| DbError::Sqlx(sqlx::Error::Protocol(e.message)))
        })
    })
    .await;
    let message = self_unlock.unwrap_err().to_string();
    assert!(
        message.contains("period_locks_unlock_second_person"),
        "{message}"
    );
    assert!(!june_open(&rt).await, "still locked");

    let unlocked = with_org_conn::<_, _, DbError>(&rt, OrgId::one(), move |tx| {
        Box::pin(async move {
            let open = load_open_unlock_request_for_update(tx, lock)
                .await?
                .unwrap();
            let id = unlock_in_tx(tx, lock, &write(open.requested_by, Some(approver)))
                .await
                .unwrap();
            approve_unlock_request_in_tx(tx, open.id, approver).await?;
            Ok(id)
        })
    })
    .await
    .unwrap();
    assert_eq!(unlocked, lock);
    assert!(june_open(&rt).await, "the approved unlock opens the window");
    let row = sqlx::query("SELECT unlocked_by, unlock_approved_by FROM period_locks WHERE id = $1")
        .bind(lock)
        .fetch_one(&owner_pool)
        .await
        .unwrap();
    assert_eq!(row.get::<Uuid, _>("unlocked_by"), requester);
    assert_eq!(row.get::<Uuid, _>("unlock_approved_by"), approver);

    // An open window cannot be unlocked again.
    let again = with_org_conn::<_, _, DbError>(&rt, OrgId::one(), move |tx| {
        Box::pin(async move { Ok(unlock_in_tx(tx, lock, &write(requester, None)).await) })
    })
    .await
    .unwrap();
    assert_eq!(again.unwrap_err().kind, ErrorKind::Conflict);
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn an_expired_window_relocks_once_and_unlocks_through_the_successor(owner_pool: PgPool) {
    let (rt, org, requester, _) = setup(&owner_pool).await;
    let expired = seed_lock(&owner_pool, org, Some((3, -1))).await;
    assert!(!june_open(&rt).await, "an expired window is locked");

    // Unlocking the old id unlocks a new successor row for the same window.
    let unlocked = with_org_conn::<_, _, DbError>(&rt, OrgId::one(), move |tx| {
        Box::pin(async move { Ok(unlock_in_tx(tx, expired, &write(requester, None)).await) })
    })
    .await
    .unwrap()
    .unwrap();
    assert_ne!(unlocked, expired);
    assert!(june_open(&rt).await);

    // Nothing is due while that window is open.
    let none = with_org_conn::<_, _, DbError>(&rt, OrgId::one(), |tx| {
        Box::pin(async move { Ok(relock_expired_in_tx(tx).await?) })
    })
    .await
    .unwrap();
    assert!(none.is_empty(), "{none:?}");

    // Another expired window: the job appends exactly one successor.
    let other = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO period_locks (org_id, domain, period_start, period_end, reason_code, \
                                   locked_at, unlocked_at, unlock_reason_code, relock_at) \
         VALUES ($1, 'accounting', DATE '2026-06-01', DATE '2026-06-30', 'BOOKS_CLOSE', \
                 now() - interval '1 day', now() - interval '3 hours', 'AUDIT_FINDING', \
                 now() - interval '1 hour') RETURNING id",
    )
    .bind(org)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    let relock = || {
        with_org_conn::<_, _, DbError>(&rt, OrgId::one(), |tx| {
            Box::pin(async move { Ok(relock_expired_in_tx(tx).await?) })
        })
    };
    let first = relock().await.unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].0, other);
    assert!(relock().await.unwrap().is_empty(), "a re-lock runs once");
}

/// Decision #17: background loops are replica-safe. Two re-lock runners at
/// once (api and worker, or two worker replicas) append exactly one successor
/// per expired window between them, and a third run finds nothing.
#[sqlx::test(migrator = "MIGRATOR")]
async fn two_concurrent_relock_runners_append_each_successor_once(owner_pool: PgPool) {
    let (rt, org, _, _) = setup(&owner_pool).await;
    let mut expired = Vec::new();
    for domain in ["payroll", "accounting"] {
        for month in 1..=6 {
            let start =
                time::Date::from_calendar_date(2026, time::Month::try_from(month).unwrap(), 1)
                    .unwrap();
            expired.push(
                sqlx::query_scalar::<_, Uuid>(
                    "INSERT INTO period_locks (org_id, domain, period_start, period_end, \
                         reason_code, locked_at, unlocked_at, unlock_reason_code, relock_at) \
                     VALUES ($1, $2, $3, ($3 + interval '1 month' - interval '1 day')::date, \
                             'MONTHLY_PAYROLL_CLOSE', now() - interval '1 day', \
                             now() - interval '3 hours', 'PAYROLL_ERROR', \
                             now() - interval '1 hour') RETURNING id",
                )
                .bind(org)
                .bind(domain)
                .bind(start)
                .fetch_one(&owner_pool)
                .await
                .unwrap(),
            );
        }
    }
    let run = || {
        with_org_conn::<_, _, DbError>(&rt, OrgId::one(), |tx| {
            Box::pin(async move { Ok(relock_expired_in_tx(tx).await?) })
        })
    };
    let (a, b) = tokio::join!(run(), run());
    let (a, b) = (a.unwrap(), b.unwrap());
    let mut relocked: Vec<Uuid> = a.iter().chain(&b).map(|(old, _)| *old).collect();
    relocked.sort();
    let mut want = expired.clone();
    want.sort();
    assert_eq!(
        relocked, want,
        "each expired window re-locked by exactly one runner"
    );

    let successors: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM period_locks WHERE org_id = $1 AND NOT (id = ANY($2))",
    )
    .bind(org)
    .bind(&expired)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(successors, i64::try_from(expired.len()).unwrap());
    assert!(
        run().await.unwrap().is_empty(),
        "nothing is left to re-lock"
    );
}
