#![allow(clippy::unwrap_used, clippy::expect_used)]
use console_platform_jobs::{
    migrate_and_reconcile_apalis_postgres,
    status::{DISPATCH_QUEUE, worker_age_seconds},
};
use sqlx::PgPool;

#[sqlx::test]
async fn status_worker_age_is_queue_scoped_read_only_and_missing_is_unknown(pool: PgPool) {
    assert!(
        worker_age_seconds(&pool).await.is_err(),
        "missing registry is unavailable"
    );
    let statement: String = sqlx::query_scalar(
        "SELECT format('ALTER DATABASE %I OWNER TO console_app', current_database())",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(statement))
        .execute(&pool)
        .await
        .unwrap();
    // The owner session on the superuser test pool: console_app's password is cluster-global and other
    // suites in the same server rotate it, so this test never logs in with it.
    let mut owner = pool.acquire().await.unwrap().detach();
    sqlx::query("SET SESSION AUTHORIZATION console_app")
        .execute(&mut owner)
        .await
        .unwrap();
    migrate_and_reconcile_apalis_postgres(&mut owner)
        .await
        .unwrap();
    drop(owner);
    assert_eq!(worker_age_seconds(&pool).await.unwrap(), None);
    sqlx::query(
        "INSERT INTO apalis.workers (id, worker_type, storage_name, last_seen) VALUES \
        ('status-old', $1, 'status-test', NOW() - INTERVAL '1 hour'), ('status-other', 'other-queue', 'status-test', NOW())",
    )
    .bind(DISPATCH_QUEUE)
    .execute(&pool)
    .await
    .unwrap();
    assert!(worker_age_seconds(&pool).await.unwrap().unwrap() >= 3600);
    sqlx::query(
        "INSERT INTO apalis.workers (id, worker_type, storage_name, last_seen) VALUES ('status-live', $1, 'status-test', NOW())",
    )
    .bind(DISPATCH_QUEUE)
    .execute(&pool)
    .await
    .unwrap();
    assert!(worker_age_seconds(&pool).await.unwrap().unwrap() <= 1);
    sqlx::query(
        "UPDATE apalis.workers SET last_seen = NOW() + INTERVAL '1 hour' WHERE id = 'status-live'",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert!(
        worker_age_seconds(&pool).await.unwrap().unwrap() < 0,
        "future evidence cannot appear fresh"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM apalis.workers")
            .fetch_one(&pool)
            .await
            .unwrap(),
        3
    );
    pool.close().await;
    assert!(
        worker_age_seconds(&pool).await.is_err(),
        "DB errors never invent freshness"
    );
}
