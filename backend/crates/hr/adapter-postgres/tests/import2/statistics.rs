//! Regression (R17): a bulk apply refreshes the planner statistics of the tables the as-of
//! membership read joins, as the runtime role. Reads planned on pre-load statistics held every
//! pooled connection for the 30 s request budget (org structure, legal entities, the next
//! dry-run). Below the threshold nothing runs.

use sqlx::PgPool;

use crate::harness::importer;
use crate::mig_job::staged;

async fn employee_reltuples(owner: &PgPool) -> f32 {
    sqlx::query_scalar("SELECT reltuples FROM pg_class WHERE oid = 'public.employees'::regclass")
        .fetch_one(owner)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_bulk_apply_refreshes_the_planner_statistics(pool: PgPool) {
    let i = importer(pool).await;
    let (run, digest) = staged(&i, 120).await;
    assert_eq!(i.apply(run, &digest).await.unwrap().inserted, 120);
    assert!(employee_reltuples(&i.owner).await >= 120.0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_small_apply_leaves_the_statistics_to_autovacuum(pool: PgPool) {
    let i = importer(pool).await;
    let (run, digest) = staged(&i, 3).await;
    assert_eq!(i.apply(run, &digest).await.unwrap().inserted, 3);
    // -1: never analyzed (a fresh database).
    assert!(employee_reltuples(&i.owner).await < 0.0);
}
