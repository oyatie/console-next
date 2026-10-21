//! BW-15: the lock guard reads `period_lock_effective()` (0248), so an unlock
//! whose window has expired is locked again even before the re-lock job runs,
//! and the refusal names the lock (`period_locked`, lock id, locker, when).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_kernel_core::{ErrorKind, OrgId};
use console_platform_db::{PERIOD_LOCKED, PeriodLockDomain, assert_period_open, with_org_conn};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::macros::date;
use uuid::Uuid;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(2)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_rt").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .unwrap()
}

/// A June payroll lock unlocked two hours ago whose window ends at
/// `relock_hours` from now (negative: already expired).
async fn seed_unlocked_lock(owner_pool: &PgPool, org: Uuid, relock_hours: i32) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO period_locks (org_id, domain, period_start, period_end, reason_code, \
                                   locked_at, unlocked_at, unlock_reason_code, relock_at) \
         VALUES ($1, 'payroll', DATE '2026-06-01', DATE '2026-06-30', 'MONTHLY_PAYROLL_CLOSE', \
                 now() - interval '1 day', now() - interval '2 hours', 'PAYROLL_ERROR', \
                 now() + make_interval(hours => $2)) RETURNING id",
    )
    .bind(org)
    .bind(relock_hours)
    .fetch_one(owner_pool)
    .await
    .unwrap()
}

async fn june_write(rt_pool: &PgPool) -> Result<(), console_kernel_core::KernelError> {
    with_org_conn::<_, _, console_platform_db::DbError>(rt_pool, OrgId::one(), |tx| {
        Box::pin(async move {
            Ok(assert_period_open(tx, PeriodLockDomain::Payroll, date!(2026 - 06 - 15)).await)
        })
    })
    .await
    .unwrap()
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn an_expired_unlock_window_locks_again_and_names_the_lock(owner_pool: PgPool) {
    let org = *OrgId::one().as_uuid();
    sqlx::query(
        "INSERT INTO organizations (id, slug, name) VALUES ($1, 'org-a', 'Org A') \
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(org)
    .execute(&owner_pool)
    .await
    .unwrap();
    let rt_pool = runtime_role_pool(&owner_pool).await;

    // Window still open: the write passes.
    seed_unlocked_lock(&owner_pool, org, 1).await;
    june_write(&rt_pool)
        .await
        .expect("an open unlock window admits the write");

    // A second row whose window expired, no successor yet: locked again.
    let expired = seed_unlocked_lock(&owner_pool, org, -1).await;
    let refused = june_write(&rt_pool)
        .await
        .expect_err("an expired unlock window must refuse the write");
    assert_eq!(refused.kind, ErrorKind::Conflict);
    assert_eq!(refused.code, Some(PERIOD_LOCKED));
    assert!(
        refused.message.contains(&expired.to_string()),
        "the refusal names the lock: {}",
        refused.message
    );
    // regression (governance-09, worst-case-04): the refusal names when the
    // lock was taken, not only its id and locker.
    let locked_at: time::OffsetDateTime =
        sqlx::query_scalar("SELECT locked_at FROM period_locks WHERE id = $1")
            .bind(expired)
            .fetch_one(&owner_pool)
            .await
            .unwrap();
    let at = locked_at
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap();
    assert!(
        refused.message.contains(&format!(
            "lock {expired} by the system at {at}: payroll period"
        )),
        "the refusal names the lock, its locker and when: {}",
        refused.message
    );
    assert!(
        refused
            .message
            .contains("payroll period 2026-06-01..2026-06-30 is locked; write dated"),
        "the frozen Korean pattern still matches: {}",
        refused.message
    );
}
