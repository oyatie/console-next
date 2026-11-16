// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
//! Separate from tests that reserve the process-wide import driver slots.

use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

#[path = "import_job_routes/fixture.rs"]
mod fixture;
#[path = "emp_ui_routes/harness.rs"]
mod harness;
use fixture::{Out, code, e, planned};
use harness::{Caller, keys, router, token, user};

async fn refused_apply(
    pool: PgPool,
    sqlstate: &str,
    status: StatusCode,
    expected: &str,
) -> Out<()> {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id,slug,name) VALUES ($1,$2,'Import refusal')")
        .bind(org)
        .bind(format!("refusal-{}", &org.simple().to_string()[..12]))
        .execute(&pool)
        .await
        .map_err(e)?;
    let actor = user(&pool, org, "SUPER_ADMIN").await;
    let (run, digest) = planned(&pool, org, actor).await?;
    // Inject a database refusal at the real writer boundary, after Cedar admission.
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "CREATE OR REPLACE FUNCTION import_api.apply_employee_import_batch(\
         p_org UUID,p_run UUID,p_source TEXT,p_rows JSONB,p_actor UUID,p_audit JSONB,\
         p_trace TEXT,p_span TEXT,p_capability UUID) RETURNS TABLE(report JSONB,replayed BOOLEAN) \
         LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$ \
         BEGIN RAISE EXCEPTION 'private database detail' USING ERRCODE='{sqlstate}'; END $$"
    )))
    .execute(&pool)
    .await
    .map_err(e)?;
    let keys = keys();
    let caller = Caller {
        service: router(&pool, &keys).await,
        token: Some(token(&pool, &keys, org, actor, "SUPER_ADMIN").await),
    };
    let (actual, body) = caller
        .call(
            "POST",
            &format!("/api/v1/employees/import/{run}/apply"),
            Some(json!({"dry_run_digest": digest})),
        )
        .await;
    assert_eq!((actual, code(&body)), (status, expected), "{body}");
    assert!(!body.to_string().contains("private database detail"));
    let (job_status, job) = caller
        .call(
            "GET",
            &format!("/api/v1/employees/import/{run}/apply"),
            None,
        )
        .await;
    assert_eq!(job_status, StatusCode::OK, "{job}");
    assert_eq!(job["state"], "failed");
    assert_eq!(job["error"]["code"], expected);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM employees WHERE org_id=$1")
        .bind(org)
        .fetch_one(&pool)
        .await
        .map_err(e)?;
    assert_eq!(count, 0);
    Ok(())
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn import_sql_permission_refusal_is_typed_403(pool: PgPool) -> Out<()> {
    refused_apply(
        pool,
        "42501",
        StatusCode::FORBIDDEN,
        "import_apply_forbidden",
    )
    .await
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn import_sql_transaction_timeout_is_typed_409(pool: PgPool) -> Out<()> {
    refused_apply(
        pool,
        "25P04",
        StatusCode::CONFLICT,
        "import_apply_timed_out",
    )
    .await
}
