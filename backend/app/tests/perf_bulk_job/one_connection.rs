//! The bulk job's batch against a one-connection runtime pool (PERF-BE).

use http::StatusCode;
use sqlx::PgPool;
use uuid::Uuid;

use crate::perf::{seed_employee, seed_org_unit};
use crate::{BULK, perf, transfer, transfers};

/// regression (e9a50dae): the batch holds a pooled connection and the
/// tenant's exclusive period lock, and each progress step awaited a SECOND
/// pooled connection inline. With that connection taken (pool of one), every
/// step waited out the acquire timeout before the batch went on, so the 발령
/// held the period lock a timeout per step longer (an 18 s commit stall at
/// 100 users ran a job to the 45 s transaction timeout). Steps are reported
/// on their own tasks; the batch never waits for them.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_a_job_batch_never_waits_on_a_second_connection(pool: PgPool) {
    let acquire = std::time::Duration::from_secs(5);
    let runtime = perf::sized_role_pool(&pool, "console_rt", 1, acquire).await;
    let (ctx, org, admin) = perf::setup_with_runtime(&pool, runtime).await;
    let people = [
        seed_employee(&pool, org, "일괄 1").await,
        seed_employee(&pool, org, "일괄 2").await,
    ];
    let unit = seed_org_unit(&pool, org, admin, "정비2팀").await;
    let (status, _, job) = ctx
        .send(
            "POST",
            BULK,
            &ctx.token,
            Some("job-key-one-conn-0001"),
            true,
            Some(transfer(&people, unit)),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{job}");
    let id = Uuid::parse_str(job["id"].as_str().unwrap()).unwrap();
    // Read from the owner pool: the runtime pool's one connection is the job's.
    let mut finished = None;
    for _ in 0..400 {
        finished = sqlx::query_as::<_, (String, f64)>(
            "SELECT state, extract(epoch FROM finished_at - created_at)::float8 \
               FROM employee_lifecycle_bulk_jobs WHERE id = $1 AND finished_at IS NOT NULL",
        )
        .bind(id)
        .fetch_optional(&pool)
        .await
        .unwrap();
        if finished.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let (state, secs) = finished.expect("the job never finished");
    assert_eq!(state, "done");
    assert_eq!(transfers(&pool, org).await, 2);
    // The old code waited one acquire timeout per step (checking, recording).
    assert!(
        secs < acquire.as_secs_f64(),
        "the batch waited on progress steps: {secs:.2} s"
    );
}
