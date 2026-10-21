#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! TS-15: the connection dies mid-transaction (the backend terminates itself
//! from a test-owned trigger), and lock / statement timeouts fire under load.
//! Each case asserts the refusal (5xx, never a success), that nothing was half
//! written (no row, no audit), and that the same Idempotency-Key then applies
//! exactly once and replays after that.

use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[path = "support/chaos.rs"]
mod chaos;
#[path = "support/http.rs"]
mod support;
use chaos::{arm_kill, arm_slow, disarm};
use support::{audits, count, ctx, employee_body, entity_body, structure, tenant, today_kst};

const ADMIN: &[&str] = &["SUPER_ADMIN"];

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn employee_create_killed_before_commit_leaves_nothing_and_its_key_creates_once(
    pool: PgPool,
) {
    let (org, user) = tenant(&pool, ADMIN).await;
    let ctx = ctx(&pool, org, user, ADMIN, None).await;
    let (_, _, branch, unit) = structure(&ctx).await;
    let body = employee_body("E-100", &branch, &unit);

    arm_kill(
        &pool,
        "audit_events",
        "AFTER INSERT",
        "NEW.action = 'employee.create'",
    )
    .await;
    let (status, died) = ctx
        .call("POST", "/api/v1/employees", Some(body.clone()))
        .await;
    assert!(
        status.is_server_error(),
        "a dead connection is never a success: {status} {died}"
    );
    assert_eq!(count(&pool, "employees", org).await, 0, "no half write");
    assert_eq!(audits(&pool, org, "employee.create").await, 0);

    disarm(&pool).await;
    let (status, created) = ctx
        .retry("POST", "/api/v1/employees", Some(body.clone()))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let (status, replay) = ctx.retry("POST", "/api/v1/employees", Some(body)).await;
    assert!(status.is_success(), "{status} {replay}");
    assert_eq!(replay["employee"]["id"], created["employee"]["id"]);
    assert_eq!(count(&pool, "employees", org).await, 1);
    assert_eq!(audits(&pool, org, "employee.create").await, 1);
}

/// The home branch is routed after the create commits (a second
/// transaction). A death there leaves the person without routing; the replay
/// of the same key must finish it, not report success over the gap.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn employee_create_killed_in_home_branch_routing_is_finished_by_the_replay(pool: PgPool) {
    let (org, user) = tenant(&pool, ADMIN).await;
    let ctx = ctx(&pool, org, user, ADMIN, None).await;
    let (_, _, branch, unit) = structure(&ctx).await;
    let body = employee_body("E-200", &branch, &unit);

    arm_kill(
        &pool,
        "employees",
        "AFTER UPDATE OF home_branch_id",
        "OLD.home_branch_id IS NULL AND NEW.home_branch_id IS NOT NULL",
    )
    .await;
    let (status, died) = ctx
        .call("POST", "/api/v1/employees", Some(body.clone()))
        .await;
    assert!(status.is_server_error(), "{status} {died}");
    disarm(&pool).await;

    let (status, replay) = ctx.retry("POST", "/api/v1/employees", Some(body)).await;
    assert!(status.is_success(), "{status} {replay}");
    let routed: Option<Uuid> =
        sqlx::query_scalar("SELECT home_branch_id FROM employees WHERE org_id = $1")
            .bind(org)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        routed.map(|b| b.to_string()),
        Some(branch),
        "the replay routes the person"
    );
    assert_eq!(count(&pool, "employees", org).await, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn entity_revise_killed_before_commit_keeps_the_version_and_its_key_revises_once(
    pool: PgPool,
) {
    let (org, user) = tenant(&pool, ADMIN).await;
    let ctx = ctx(&pool, org, user, ADMIN, None).await;
    let (entity, ..) = structure(&ctx).await;
    let uri = format!("/api/v1/legal-entities/{entity}");
    let (_, read) = ctx.call("GET", &uri, None).await;
    let version = read["current"]["version"].as_i64().unwrap();
    let mut revise = entity_body();
    revise["name"] = json!("주식회사 가나다");
    revise["expected_version"] = json!(version);
    revise["effective_from"] = json!(today_kst());
    revise["reason_code"] = json!("RENAME");
    let current = |v: &Value| {
        (
            v["current"]["name"].clone(),
            v["current"]["version"].clone(),
        )
    };

    arm_kill(
        &pool,
        "audit_events",
        "AFTER INSERT",
        "NEW.action = 'legal_entity.revise'",
    )
    .await;
    let (status, died) = ctx.call("PUT", &uri, Some(revise.clone())).await;
    let key = Some(ctx.key.get());
    assert!(status.is_server_error(), "{status} {died}");
    let (_, read) = ctx.call("GET", &uri, None).await;
    assert_eq!(
        current(&read),
        (json!("주식회사 가나"), json!(version)),
        "{read}"
    );
    assert_eq!(audits(&pool, org, "legal_entity.revise").await, 0);

    disarm(&pool).await;
    let (status, revised) = ctx.send("PUT", &uri, Some(revise.clone()), key).await;
    assert_eq!(status, StatusCode::OK, "{revised}");
    let (status, _) = ctx.send("PUT", &uri, Some(revise.clone()), key).await;
    assert_eq!(status, StatusCode::OK, "the same key replays");
    let (_, read) = ctx.call("GET", &uri, None).await;
    assert_eq!(
        current(&read),
        (json!("주식회사 가나다"), json!(version + 1)),
        "{read}"
    );
    assert_eq!(audits(&pool, org, "legal_entity.revise").await, 1);
    // Negative: a new intent on the old version is stale, and changes nothing.
    let (status, stale) = ctx.call("PUT", &uri, Some(revise)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{stale}");
    assert_eq!(stale["error"]["code"], "stale_revision");
    assert_eq!(stale["error"]["current_version"], version + 1);
}

/// A lock held across the employees table: every create gives up at the
/// session's lock_timeout instead of queueing, writes nothing, and each key
/// then creates once after the lock is gone.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn creates_under_a_held_lock_time_out_writing_nothing_then_each_key_creates_once(
    pool: PgPool,
) {
    let (org, user) = tenant(&pool, ADMIN).await;
    let ctx = ctx(&pool, org, user, ADMIN, Some("SET lock_timeout = '300ms'")).await;
    let (_, _, branch, unit) = structure(&ctx).await;
    let bodies: Vec<(Uuid, Value)> = (0..6)
        .map(|i| {
            (
                Uuid::new_v4(),
                employee_body(&format!("E-30{i}"), &branch, &unit),
            )
        })
        .collect();
    let send_all = || {
        futures::future::join_all(bodies.iter().map(|(key, body)| {
            ctx.send("POST", "/api/v1/employees", Some(body.clone()), Some(*key))
        }))
    };

    let mut holder = pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE employees IN EXCLUSIVE MODE")
        .execute(&mut *holder)
        .await
        .unwrap();
    let started = std::time::Instant::now();
    for (status, refused) in send_all().await {
        // Today a lock timeout surfaces as 500 `internal` (backend-followups
        // TB-2 asks for 503 + Retry-After); never a success, never a 4xx blame.
        assert!(
            status.is_server_error(),
            "a create went through a held lock: {status} {refused}"
        );
    }
    assert!(
        started.elapsed().as_secs() < 20,
        "requests queued instead of timing out"
    );
    holder.rollback().await.unwrap();
    assert_eq!(count(&pool, "employees", org).await, 0, "no half write");

    // One at a time: under a 300 ms lock_timeout the creates would also time
    // out on each other (the same 500), which is the storm, not the recovery.
    for (key, body) in &bodies {
        let (status, created) = ctx
            .send("POST", "/api/v1/employees", Some(body.clone()), Some(*key))
            .await;
        assert_eq!(status, StatusCode::CREATED, "{created}");
        let (status, replay) = ctx
            .send("POST", "/api/v1/employees", Some(body.clone()), Some(*key))
            .await;
        assert!(status.is_success(), "{status} {replay}");
        assert_eq!(replay["employee"]["id"], created["employee"]["id"]);
    }
    assert_eq!(count(&pool, "employees", org).await, 6);
    assert_eq!(audits(&pool, org, "employee.create").await, 6);
}

/// A statement that outlives statement_timeout is cancelled and rolled back.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_create_cancelled_by_statement_timeout_writes_nothing_and_its_key_creates_once(
    pool: PgPool,
) {
    let (org, user) = tenant(&pool, ADMIN).await;
    let ctx = ctx(
        &pool,
        org,
        user,
        ADMIN,
        Some("SET statement_timeout = '500ms'"),
    )
    .await;
    let (_, _, branch, unit) = structure(&ctx).await;
    let body = employee_body("E-400", &branch, &unit);

    arm_slow(&pool, "employees", "AFTER INSERT", "true", 2.0).await;
    let (status, refused) = ctx
        .call("POST", "/api/v1/employees", Some(body.clone()))
        .await;
    assert!(!status.is_success(), "{status} {refused}");
    assert_eq!(count(&pool, "employees", org).await, 0, "no half write");
    disarm(&pool).await;
    let (status, created) = ctx.retry("POST", "/api/v1/employees", Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    assert_eq!(count(&pool, "employees", org).await, 1);
}
