// SPDX-License-Identifier: LicenseRef-Proprietary
use sqlx::PgPool;

use crate::harness::importer;
use crate::mig_job::{body, progress_events, staged};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn apply_admission_uses_live_cedar_facts_before_starting_a_job(pool: PgPool) {
    let i = importer(pool).await;
    let (run, digest) = staged(&i, 2).await;
    sqlx::query("UPDATE users SET roles=ARRAY['MEMBER'] WHERE org_id=$1 AND id=$2")
        .bind(i.org())
        .bind(i.f.principal.user_id.as_uuid())
        .execute(&i.owner)
        .await
        .unwrap();
    let error =
        i.f.hr
            .start_apply(i.f.principal.clone(), run, body(&digest))
            .await
            .unwrap_err();
    assert_eq!(error.status.as_u16(), 403);
    assert_eq!(
        i.f.hr
            .apply_job(i.f.principal.org_id, run)
            .await
            .unwrap_err()
            .status
            .as_u16(),
        404
    );
    assert_eq!(
        i.count("SELECT count(*) FROM employees WHERE org_id=$1")
            .await,
        0
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_second_driver_of_a_completed_job_keeps_the_report_and_audits(pool: PgPool) {
    let i = importer(pool).await;
    let (run, digest) = staged(&i, 2).await;
    let report = i.apply(run, &digest).await.unwrap();
    let events = progress_events(&i, run).await;
    let replay =
        i.f.hr
            .drive_apply(Some(i.store.clone()), i.f.principal.org_id, run)
            .await
            .unwrap();
    assert_eq!(
        serde_json::to_value(replay).unwrap(),
        serde_json::to_value(report).unwrap()
    );
    assert_eq!(progress_events(&i, run).await, events);
    assert_eq!(
        i.count("SELECT count(*) FROM employees WHERE org_id=$1")
            .await,
        2
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn runtime_cannot_mint_read_or_forge_an_import_capability(pool: PgPool) {
    let i = importer(pool).await;
    let (run, digest) = staged(&i, 2).await;
    i.f.hr
        .start_apply(i.f.principal.clone(), run, body(&digest))
        .await
        .unwrap();
    let org = i.f.principal.org_id;
    let actor = i.f.principal.user_id;
    for query in [
        "SELECT import_api.employee_import_capability($1,$2,$3)",
        "SELECT token FROM import_apply_capabilities WHERE org_id=$1 AND run_id=$2 AND actor_id=$3",
        "SELECT * FROM import_api.apply_employee_import_batch($1,$2,'run:'||$2::text,'[]'::jsonb,$3, \
         jsonb_build_object('dry_run_digest',(SELECT dry_run_digest FROM data_import_runs WHERE org_id=$1 AND id=$2)), \
         repeat('a',32),repeat('b',16),gen_random_uuid())",
    ] {
        let mut tx = i.f.rt.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org',$1,true)")
            .bind(org.to_string())
            .execute(tx.as_mut())
            .await
            .unwrap();
        let error = sqlx::query(query)
            .bind(org.as_uuid())
            .bind(run)
            .bind(actor.as_uuid())
            .execute(tx.as_mut())
            .await
            .unwrap_err();
        assert_eq!(
            error
                .as_database_error()
                .and_then(|error| error.code())
                .as_deref(),
            Some("42501"),
            "{query}: {error}"
        );
        tx.rollback().await.unwrap();
    }
    assert_eq!(
        i.count("SELECT count(*) FROM employees WHERE org_id=$1")
            .await,
        0
    );
    i.f.hr
        .drive_apply(Some(i.store.clone()), org, run)
        .await
        .unwrap();
    assert_eq!(
        i.count("SELECT count(*) FROM import_apply_capabilities WHERE org_id=$1")
            .await,
        0,
        "the capability is spent in the apply transaction"
    );
    // The unchanged command entry point remains callable after the capability bridge is installed.
    let (legacy_run, digest) = staged(&i, 2).await;
    let report = console_platform_request_context::scope_org(
        org,
        i.store.apply_employee_import_batch(
            Some(legacy_run),
            &format!("run:{legacy_run}"),
            &serde_json::json!([]),
            actor,
            &serde_json::json!({"dry_run_digest": digest}),
            console_kernel_core::TraceContext::generate(),
        ),
    )
    .await
    .unwrap();
    assert_eq!(report["inserted"], 0);
    assert_eq!(
        i.count("SELECT count(*) FROM employees WHERE org_id=$1")
            .await,
        2
    );
}
