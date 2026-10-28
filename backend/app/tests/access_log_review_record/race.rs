// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use sqlx::postgres::PgPoolOptions;
use std::time::Duration;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn fresh_key_starts_really_race_on_two_connections(pool: PgPool) {
    let org = OrgId::new();
    let user = seed_org_and_super_admin(&pool, *org.as_uuid(), "start-race").await;
    reviewer(&pool, org, user).await;
    let mut pids = Vec::new();
    let mut services = Vec::new();
    for _ in 0..2 {
        let rt = PgPoolOptions::new()
            .max_connections(1)
            .after_connect(|conn, _| {
                Box::pin(async move {
                    sqlx::query("SET ROLE console_rt").execute(conn).await?;
                    Ok(())
                })
            })
            .connect_with(pool.connect_options().as_ref().clone())
            .await
            .unwrap();
        pids.push(
            sqlx::query_scalar::<_, i32>("SELECT pg_backend_pid()")
                .fetch_one(&rt)
                .await
                .unwrap(),
        );
        services.push(AccessService::new(rt, None));
    }
    // Both commands must reach a database lock before either can insert evidence.
    // Without the review advisory lock both observe no start and queue an insert.
    let mut barrier = pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE audit_events IN SHARE MODE")
        .execute(barrier.as_mut())
        .await
        .unwrap();
    let mut tasks = Vec::new();
    for (n, service) in services.into_iter().enumerate() {
        let p = principal(org, user);
        tasks.push(tokio::spawn(async move {
            record::start(
                &service,
                p,
                "2026-09".into(),
                format!("true-race-start-key-{n}"),
            )
            .await
        }));
    }
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let waiting: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE pid=ANY($1) AND wait_event_type='Lock'")
                .bind(&pids).fetch_one(&pool).await.unwrap();
            if waiting == 2 { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("two distinct runtime connections must overlap at the barrier");
    barrier.rollback().await.unwrap();
    let mut results = Vec::new();
    for task in tasks {
        results.push(task.await.unwrap().unwrap());
    }
    assert_eq!(results[0]["id"], results[1]["id"]);
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='access_log_review.start'",
    )
    .bind(org.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
}
