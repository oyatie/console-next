// SPDX-License-Identifier: LicenseRef-Proprietary
//! A settle refusal rolls back the whole import and keeps its typed reason.
use sqlx::PgPool;

use super::shared::{setup_headquarters, stage_roster};
use crate::harness::importer;

async fn refused_settle(pool: PgPool, state: &str, status: u16, code: &str) {
    let i = importer(pool).await;
    let (_, workplace) = setup_headquarters(&i, i.f.branch).await;
    let workplace_name: String = sqlx::query_scalar(
        "SELECT name FROM workplace_revisions WHERE org_id=$1 AND workplace_id=$2",
    )
    .bind(i.org())
    .bind(workplace)
    .fetch_one(&i.owner)
    .await
    .unwrap();
    let (run, digest) = stage_roster(
        &i,
        "Roster",
        &[&[
            "REF-1",
            "Example",
            "2024-03-04",
            "REGULAR",
            &workplace_name,
            "",
            "Staff",
        ]],
    )
    .await;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "CREATE OR REPLACE FUNCTION import_api.set_employee_import_home_branch(\
         p_org UUID,p_run UUID,p_employee UUID,p_actor UUID,p_trace TEXT,p_span TEXT) \
         RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ \
         BEGIN RAISE EXCEPTION 'private settle detail' USING ERRCODE='{state}'; END $$"
    )))
    .execute(&i.owner)
    .await
    .unwrap();
    let error = i.apply(run, &digest).await.unwrap_err();
    assert_eq!((error.status.as_u16(), error.code), (status, code));
    assert!(!error.message.contains("private settle detail"));
    assert_eq!(
        i.count("SELECT count(*) FROM employees WHERE org_id=$1")
            .await,
        0
    );
    let job = i.f.hr.apply_job(i.f.principal.org_id, run).await.unwrap();
    assert_eq!(job.state, "failed");
    assert_eq!(job.error.unwrap()["code"], code);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn settle_permission_refusal_is_typed_403(pool: PgPool) {
    refused_settle(pool, "42501", 403, "import_apply_forbidden").await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn settle_statement_timeout_is_typed_503(pool: PgPool) {
    refused_settle(pool, "57014", 503, "import_apply_timed_out").await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn settle_transaction_timeout_is_typed_503(pool: PgPool) {
    refused_settle(pool, "25P04", 503, "import_apply_timed_out").await;
}
