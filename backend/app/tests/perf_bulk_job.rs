#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! PERF-BE CAP-04 (decisions #27, #28) over HTTP as `console_rt`: the bulk
//! 발령 sent with `Prefer: respond-async` is a job — 202 + Location, then the
//! batch exactly once (all or nothing), its outcome on `GET …/bulk/jobs/{id}`,
//! audited progress steps — and every refusal answers with nothing written.

#[path = "support/go_live.rs"]
mod go_live;
#[path = "perf_bulk_job/one_connection.rs"]
mod one_connection;
#[path = "support/perf.rs"]
mod perf;

use console_hr_adapter_postgres::lifecycle::bulk_job::DriverSlot;
use http::StatusCode;
use perf::{Ctx, kst_today, seed_employee, seed_org_unit, setup};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

pub(crate) const BULK: &str = "/api/v1/employees/lifecycle-events/bulk";

pub(crate) fn transfer(ids: &[Uuid], unit: Uuid) -> Value {
    json!({
        "event_type": "TRANSFER", "employee_ids": ids, "to_org_unit_id": unit,
        "effective_date": kst_today(), "comment": "일괄 발령",
        "signoffs": {"privacy_notice_ack": true, "korean_labor_law_ack": true},
    })
}

async fn count(pool: &PgPool, sql: &'static str, org: Uuid) -> i64 {
    sqlx::query_scalar(sql)
        .bind(org)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn jobs(pool: &PgPool, org: Uuid) -> i64 {
    count(
        pool,
        "SELECT count(*) FROM employee_lifecycle_bulk_jobs WHERE org_id = $1",
        org,
    )
    .await
}

pub(crate) async fn transfers(pool: &PgPool, org: Uuid) -> i64 {
    count(pool, "SELECT count(*) FROM employee_lifecycle_events WHERE org_id = $1 AND event_type = 'TRANSFER'", org).await
}

/// Reads the job until it leaves queued/running (the driver is a spawned task).
async fn settled(ctx: &Ctx, token: &str, location: &str) -> Value {
    for _ in 0..200 {
        let (status, _, job) = ctx.send("GET", location, token, None, false, None).await;
        assert_eq!(status, StatusCode::OK, "{job}");
        if matches!(job["state"].as_str(), Some("done" | "failed")) {
            return job;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("the job never finished");
}

/// regression (CAP-04): the 500-person 발령 answered only synchronously
/// (p95 3.0-4.0 s against "accepted <= 1 s"); `Prefer` was ignored.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_an_async_bulk_transfer_is_a_job_recorded_exactly_once(pool: PgPool) {
    let (ctx, org, admin) = setup(&pool).await;
    let people = [
        seed_employee(&pool, org, "일괄 1").await,
        seed_employee(&pool, org, "일괄 2").await,
    ];
    let unit = seed_org_unit(&pool, org, admin, "정비2팀").await;
    let body = transfer(&people, unit);

    let (status, headers, job) = ctx
        .send(
            "POST",
            BULK,
            &ctx.token,
            Some("job-key-applied-0001"),
            true,
            Some(body.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{job}");
    let location = headers
        .get("location")
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        location,
        format!("{BULK}/jobs/{}", job["id"].as_str().unwrap())
    );
    let done = settled(&ctx, &ctx.token, &location).await;
    assert_eq!(done["state"], "done", "{done}");
    assert_eq!(done["result"]["items"].as_array().unwrap().len(), 2);
    assert_eq!(transfers(&pool, org).await, 2);
    let (bulk_audits, steps): (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE action = 'employee.lifecycle.bulk'), \
                count(*) FILTER (WHERE action = 'employee.lifecycle.bulk.progress' AND target_id = $2) \
           FROM audit_events WHERE org_id = $1",
    )
    .bind(org)
    .bind(job["id"].as_str().unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(bulk_audits, 1);
    // queued and done always; the in-batch steps are best-effort (own tasks).
    assert!(steps >= 2, "queued and done at least: {steps}");

    // Replay: the same key and body answer the same job; nothing runs twice.
    let (status, _, replay) = ctx
        .send(
            "POST",
            BULK,
            &ctx.token,
            Some("job-key-applied-0001"),
            true,
            Some(body.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(replay["id"], job["id"]);
    // The same key sent synchronously replays the batch the job recorded.
    let (status, _, sync) = ctx
        .send(
            "POST",
            BULK,
            &ctx.token,
            Some("job-key-applied-0001"),
            false,
            Some(body),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{sync}");
    assert_eq!(sync["batch_id"], done["result"]["batch_id"]);
    assert_eq!(
        (transfers(&pool, org).await, jobs(&pool, org).await),
        (2, 1)
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn async_bulk_refusals_write_nothing(pool: PgPool) {
    let (ctx, org, admin) = setup(&pool).await;
    let person = seed_employee(&pool, org, "일괄 1").await;
    let unit = seed_org_unit(&pool, org, admin, "정비2팀").await;

    // 422 on the spot for the request's own checks: no job.
    let mut bad = transfer(&[person], unit);
    bad["event_type"] = "RETIRE".into();
    let (status, _, body) = ctx
        .send(
            "POST",
            BULK,
            &ctx.token,
            Some("job-key-bad-kind-0001"),
            true,
            Some(bad),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    // 422 without an Idempotency-Key.
    let (status, _, _) = ctx
        .send(
            "POST",
            BULK,
            &ctx.token,
            None,
            true,
            Some(transfer(&[person], unit)),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    // 403 for a caller who may not manage the directory: no job, no read.
    let (status, _, body) = ctx
        .send(
            "POST",
            BULK,
            &ctx.roleless,
            Some("job-key-forbidden-001"),
            true,
            Some(transfer(&[person], unit)),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(jobs(&pool, org).await, 0);

    // A refused employee fails the job with the batch's refusal; nothing recorded.
    let missing = Uuid::new_v4();
    let (status, _, job) = ctx
        .send(
            "POST",
            BULK,
            &ctx.token,
            Some("job-key-refused-0001"),
            true,
            Some(transfer(&[person, missing], unit)),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{job}");
    let location = format!("{BULK}/jobs/{}", job["id"].as_str().unwrap());
    let failed = settled(&ctx, &ctx.token, &location).await;
    assert_eq!(failed["state"], "failed", "{failed}");
    assert_eq!(failed["error"]["code"], "bulk_lifecycle_refused");
    assert_eq!(
        failed["error"]["refusals"][0]["employee_id"],
        missing.to_string()
    );
    assert_eq!(transfers(&pool, org).await, 0);
    let (status, _, _) = ctx
        .send("GET", &location, &ctx.roleless, None, false, None)
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // The same key with another body: 409, the stored job untouched.
    let (status, _, body) = ctx
        .send(
            "POST",
            BULK,
            &ctx.token,
            Some("job-key-refused-0001"),
            true,
            Some(transfer(&[person], unit)),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(jobs(&pool, org).await, 1);

    // Every driver busy: 503 bulk_lifecycle_busy + Retry-After, no job started.
    let held = [DriverSlot::take().unwrap(), DriverSlot::take().unwrap()];
    let (status, headers, body) = ctx
        .send(
            "POST",
            BULK,
            &ctx.token,
            Some("job-key-busy-000001"),
            true,
            Some(transfer(&[person], unit)),
        )
        .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(body["error"]["code"], "bulk_lifecycle_busy");
    assert_eq!(headers.get("retry-after").unwrap(), "15");
    assert_eq!(jobs(&pool, org).await, 1);
    drop(held);

    // Another tenant's job is not found.
    let (other, _, _) = setup(&pool).await;
    let (status, _, _) = other
        .send("GET", &location, &other.token, None, false, None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

/// regression-guard (CAP-04): a job whose driver died is never re-run by the
/// schedule loop; it is finished from what committed — `done` with the
/// stored batch when the Idempotency-Key holds one, else `failed`
/// `bulk_job_interrupted` — and a job with a live heartbeat is left alone.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn stale_jobs_are_finished_from_what_committed_never_rerun(pool: PgPool) {
    let (_ctx, org, admin) = setup(&pool).await;
    let job = |key: &'static str, age_secs: i32| {
        let pool = pool.clone();
        async move {
            sqlx::query_scalar::<_, Uuid>(
                "INSERT INTO employee_lifecycle_bulk_jobs (org_id, idempotency_key, request_fingerprint, \
                 request, requested_by, state, heartbeat_at) VALUES ($1, $2, repeat('a', 64), '{}', $3, \
                 'running', now() - make_interval(secs => $4)) RETURNING id",
            )
            .bind(org)
            .bind(key)
            .bind(*admin.as_uuid())
            .bind(f64::from(age_secs))
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    let committed = job("stale-committed-key-01", 600).await;
    let lost = job("stale-lost-batch-key-01", 600).await;
    let live = job("live-driver-key-000001", 5).await;
    sqlx::query(
        "INSERT INTO api_idempotency_keys (org_id, operation, idempotency_key, request_fingerprint, \
         response, completed_at) VALUES ($1, 'employee.lifecycle.bulk', 'stale-committed-key-01', \
         repeat('a', 64), '{\"batch_id\": \"b\", \"items\": [{}, {}]}', now())",
    )
    .bind(org)
    .execute(&pool)
    .await
    .unwrap();
    let hr =
        console_hr_adapter_postgres::HrService::new(perf::role_pool(&pool, "console_rt").await);
    assert_eq!(hr.finish_stale_bulk_lifecycle_jobs().await.unwrap(), 2);
    let state = |id: Uuid| {
        let pool = pool.clone();
        async move {
            sqlx::query_as::<_, (String, Option<Value>, Option<Value>, i32)>(
                "SELECT state, result, error, done FROM employee_lifecycle_bulk_jobs WHERE id = $1",
            )
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    let (s, result, _, done) = state(committed).await;
    assert_eq!((s.as_str(), done), ("done", 2));
    assert_eq!(result.unwrap()["batch_id"], "b");
    let (s, _, error, _) = state(lost).await;
    assert_eq!(s, "failed");
    assert_eq!(error.unwrap()["code"], "bulk_job_interrupted");
    assert_eq!(state(live).await.0, "running");
    assert_eq!(
        hr.finish_stale_bulk_lifecycle_jobs().await.unwrap(),
        0,
        "finished once"
    );
}
