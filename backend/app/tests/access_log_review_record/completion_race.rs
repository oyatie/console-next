// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{completion::*, *};
use sqlx::postgres::PgPoolOptions;
use std::time::Duration;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn completion_waits_for_a_concurrent_finding_transaction(pool: PgPool) {
    let (org, user, service, p) = setup(&pool).await;
    let id = event(
        &pool,
        org,
        user,
        "employee.rrn_reveal",
        "2026-09-01T02:00:00Z",
        json!({}),
    )
    .await;
    record::start(
        &service,
        p.clone(),
        "2026-09".into(),
        "finding-race-start".into(),
    )
    .await
    .unwrap();
    append(
        &pool,
        org,
        user,
        "2026-09",
        "access_log_review.finding",
        json!({"event_id":id,"disposition":"confirmed","follow_up":{"kind":"none","closed":true}}),
    )
    .await;
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
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&rt)
        .await
        .unwrap();
    let service = AccessService::new(rt, None);
    // The future findings writer uses this same tenant-period lock and append-only row.
    let runtime = runtime_role_pool(&pool).await;
    let mut finding = arm(&runtime, org).await;
    let finding_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(finding.as_mut())
        .await
        .unwrap();
    assert_ne!(pid, finding_pid);
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))")
        .bind(org.to_string())
        .bind("tenant:2026-09")
        .execute(finding.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO audit_events(org_id,actor,action,target_type,target_id,trace_id,span_id,occurred_at,after_snap) VALUES($1,$2,'access_log_review.finding','access_log_review','tenant:2026-09',repeat('a',32),repeat('b',16),now(),$3)")
        .bind(org.as_uuid()).bind(user.as_uuid()).bind(json!({"event_id":id,"disposition":"action_required","outcome":null,"follow_up":{"kind":"none","closed":true}})).execute(finding.as_mut()).await.unwrap();
    let task = tokio::spawn(async move {
        record::complete(
            &service,
            p,
            "2026-09".into(),
            "finding-race-complete".into(),
            None,
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            assert!(!task.is_finished(), "completion must wait for the uncommitted finding");
            let waiting: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event='advisory' AND $2=ANY(pg_blocking_pids(pid)))")
                .bind(pid).bind(finding_pid).fetch_one(&pool).await.unwrap();
            if waiting { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("completion must block on the finding's advisory lock");
    finding.commit().await.unwrap();
    let error = task.await.unwrap().unwrap_err();
    assert_eq!(error.code, "review_incomplete");
    assert_eq!(
        error.details.as_deref(),
        Some(&json!({"open_event_ids":[id]}))
    );
    assert_eq!(refused_count(&pool, org, "review_incomplete").await, 1);
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='access_log_review.complete'",
    )
    .bind(org.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 0);
}
