//! regression (r3:hire-02): an inline apply (no `Prefer: respond-async`)
//! whose request is dropped mid-way — the 30 s request timeout under load —
//! stopped its driver with it: the roster was left half settled (no
//! employment type, people unplaced) until the schedule loop resumed it minutes later,
//! and the screen offered the apply again. The driver now outlives the request.

use std::time::Duration;

use axum::body::Body;
use http::{Request, StatusCode, header};
use serde_json::json;
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

use super::harness::{Caller, keys, router, token, user};
use super::{Out, completed_job, e, planned};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_an_inline_apply_whose_request_is_dropped_still_finishes(
    pool: PgPool,
) -> Out<()> {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'R3 hire-02')")
        .bind(org)
        .bind(format!("r3h2-{}", &org.simple().to_string()[..12]))
        .execute(&pool)
        .await
        .map_err(e)?;
    let keys = keys();
    let service = router(&pool, &keys).await;
    let ops_id = user(&pool, org, "SUPER_ADMIN").await;
    let ops = Caller {
        service: service.clone(),
        token: Some(token(&pool, &keys, org, ops_id, "SUPER_ADMIN").await),
    };
    let (run, digest) = planned(&pool, org, ops_id).await?;
    let apply = format!("/api/v1/employees/import/{run}/apply");

    // Another writer holds the roster: the apply blocks inside its driver.
    let mut holder = pool.begin().await.map_err(e)?;
    sqlx::query("LOCK TABLE employees IN EXCLUSIVE MODE")
        .execute(&mut *holder)
        .await
        .map_err(e)?;
    let request = Request::builder()
        .method("POST")
        .uri(&apply)
        .header(header::CONTENT_TYPE, "application/json")
        .header(
            header::AUTHORIZATION,
            format!("Bearer {}", ops.token.clone().unwrap_or_default()),
        )
        .body(Body::from(json!({ "dry_run_digest": digest }).to_string()))
        .map_err(e)?;
    let mut response = Box::pin(service.oneshot(request));
    let started = async {
        loop {
            let applying: bool = sqlx::query_scalar(
                "SELECT COALESCE(apply_job->>'state'='applying',false) FROM data_import_runs WHERE id=$1",
            )
            .bind(run)
            .fetch_one(&pool)
            .await
            .map_err(e)?;
            if applying {
                return Ok::<(), String>(());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    };
    // Cancel only after admission: a slow fact load must not turn this into an unstarted request.
    tokio::select! {
        result = &mut response => return Err(format!("blocked apply returned early: {}", result.map_err(e)?.status())),
        result = tokio::time::timeout(Duration::from_secs(60), started) => result.map_err(e)??,
    }
    drop(response);
    holder.commit().await.map_err(e)?;

    // The job still reaches done, settled: the person is in, unplaced counted.
    let job = completed_job(&ops, &apply).await;
    assert_eq!(job["report"]["inserted"], 1, "{job}");
    let (_, unplaced) = ops
        .call("GET", "/api/v1/employees/import/unplaced", None)
        .await;
    assert_eq!(unplaced["count"], 1, "{unplaced}");
    Ok(())
}

/// A longer async run (here: blocked) answers 202 with its job within the
/// grace, and the job still reaches done once the roster is free.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_async_apply_past_the_grace_answers_its_job_and_finishes(pool: PgPool) -> Out<()> {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'R3 grace')")
        .bind(org)
        .bind(format!("r3gr-{}", &org.simple().to_string()[..12]))
        .execute(&pool)
        .await
        .map_err(e)?;
    let keys = keys();
    let service = router(&pool, &keys).await;
    let ops_id = user(&pool, org, "SUPER_ADMIN").await;
    let ops = Caller {
        service: service.clone(),
        token: Some(token(&pool, &keys, org, ops_id, "SUPER_ADMIN").await),
    };
    let (run, digest) = planned(&pool, org, ops_id).await?;
    let apply = format!("/api/v1/employees/import/{run}/apply");
    let mut holder = pool.begin().await.map_err(e)?;
    sqlx::query("LOCK TABLE employees IN EXCLUSIVE MODE")
        .execute(&mut *holder)
        .await
        .map_err(e)?;
    let request = Request::builder()
        .method("POST")
        .uri(&apply)
        .header(header::CONTENT_TYPE, "application/json")
        .header("prefer", "respond-async")
        .header(
            header::AUTHORIZATION,
            format!("Bearer {}", ops.token.clone().unwrap_or_default()),
        )
        .body(Body::from(json!({ "dry_run_digest": digest }).to_string()))
        .map_err(e)?;
    let accepted = service.oneshot(request).await.map_err(e)?;
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    holder.commit().await.map_err(e)?;
    let job = completed_job(&ops, &apply).await;
    assert_eq!(job["report"]["inserted"], 1, "{job}");
    Ok(())
}
