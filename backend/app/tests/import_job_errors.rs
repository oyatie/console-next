// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
//! A successful job GET must never expose internal diagnostics, including old jobs.
use console_hr_adapter_postgres::{HrError, import::apply_job::ApplyJob};
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use tracing::instrument::WithSubscriber;
use uuid::Uuid;

#[allow(dead_code)]
#[path = "support/reference_logs.rs"]
mod reference_logs;

#[allow(dead_code)]
#[path = "import_job_routes/fixture.rs"]
mod fixture;
#[path = "emp_ui_routes/harness.rs"]
mod harness;
use fixture::{Out, e, planned};
use harness::{Caller, keys, router, token, user};

async fn failed_job(pool: PgPool, legacy: bool) -> Out<()> {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Import job error')")
        .bind(org)
        .bind(format!("job-{}", org.simple()))
        .execute(&pool)
        .await
        .map_err(e)?;
    let actor = user(&pool, org, "SUPER_ADMIN").await;
    let (run, digest) = planned(&pool, org, actor).await?;
    let job = ApplyJob::queued(run, &digest, actor).failed(&HrError::internal(
        "employment assignment write failed: private database value",
    ));
    let mut stored = json!(job);
    if legacy {
        stored["error"] = json!({
            "code": "internal", "message": "private database value",
            "refusals": [{"detail": "private refusal value"}],
        });
    } else {
        assert!(!stored.to_string().contains("private"), "{stored}");
        assert!(stored["error"]["support_ref"].is_string(), "{stored}");
    }
    sqlx::query("UPDATE data_import_runs SET apply_job=$2 WHERE id=$1")
        .bind(run)
        .bind(&stored)
        .execute(&pool)
        .await
        .map_err(e)?;
    let keys = keys();
    let caller = Caller {
        service: router(&pool, &keys).await,
        token: Some(token(&pool, &keys, org, actor, "SUPER_ADMIN").await),
    };
    let (status, body) = caller
        .call(
            "GET",
            &format!("/api/v1/employees/import/{run}/apply"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["state"], "failed");
    assert_eq!(body["error"]["code"], "internal");
    assert_eq!(body["error"]["message"], "internal server error");
    assert!(!body.to_string().contains("private"), "{body}");
    assert!(body["error"].get("refusals").is_none(), "{body}");
    if !legacy {
        assert_eq!(body["error"]["support_ref"], stored["error"]["support_ref"]);
        let persisted: Value =
            sqlx::query_scalar("SELECT apply_job FROM data_import_runs WHERE id=$1")
                .bind(run)
                .fetch_one(&pool)
                .await
                .map_err(e)?;
        assert_eq!(persisted, stored);
    }
    Ok(())
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn newly_failed_job_stores_and_serves_only_safe_diagnostics(pool: PgPool) -> Out<()> {
    failed_job(pool, false).await
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn legacy_failed_job_redacts_diagnostics_on_successful_get(pool: PgPool) -> Out<()> {
    failed_job(pool, true).await
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn database_failure_is_redacted_before_the_driver_stores_it(pool: PgPool) -> Out<()> {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Import driver error')")
        .bind(org)
        .bind(format!("driver-{}", org.simple()))
        .execute(&pool)
        .await
        .map_err(e)?;
    let actor = user(&pool, org, "SUPER_ADMIN").await;
    let (run, digest) = planned(&pool, org, actor).await?;
    sqlx::raw_sql(
        "CREATE OR REPLACE FUNCTION import_api.apply_employee_import_batch(\
         p_org UUID,p_run UUID,p_source TEXT,p_rows JSONB,p_actor UUID,p_audit JSONB,\
         p_trace TEXT,p_span TEXT,p_capability UUID) RETURNS TABLE(report JSONB,replayed BOOLEAN) \
         LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ \
         BEGIN RAISE EXCEPTION 'private database value'; END $$",
    )
    .execute(&pool)
    .await
    .map_err(e)?;
    let keys = keys();
    let caller = Caller {
        service: router(&pool, &keys).await,
        token: Some(token(&pool, &keys, org, actor, "SUPER_ADMIN").await),
    };
    let logs = reference_logs::Logs::default();
    let writer = logs.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .json()
        .with_writer(move || writer.clone())
        .finish();
    let (status, body) = caller
        .call(
            "POST",
            &format!("/api/v1/employees/import/{run}/apply"),
            Some(json!({"dry_run_digest": digest})),
        )
        .with_subscriber(subscriber)
        .await;
    let raw = String::from_utf8(logs.0.lock().unwrap().clone()).map_err(e)?;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}\n{raw}");
    assert_eq!(body["error"]["code"], "internal");
    assert!(!body.to_string().contains("private"), "{body}");
    assert!(raw.contains("private database value"), "{raw}");
    let stored: Value = sqlx::query_scalar("SELECT apply_job FROM data_import_runs WHERE id=$1")
        .bind(run)
        .fetch_one(&pool)
        .await
        .map_err(e)?;
    assert_eq!(stored["state"], "failed");
    assert_eq!(stored["error"]["message"], "internal server error");
    assert!(!stored.to_string().contains("private"), "{stored}");
    assert_eq!(stored["error"]["support_ref"], body["error"]["support_ref"]);
    let (status, job) = caller
        .call(
            "GET",
            &format!("/api/v1/employees/import/{run}/apply"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{job}");
    assert_eq!(job["error"], stored["error"]);
    Ok(())
}
