// SPDX-License-Identifier: LicenseRef-Proprietary
//! A second holder queues a large reversal; its durable approval survives until execution.
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn large_routed_decision_executes_as_the_approved_actor_in_a_job(pool: PgPool) {
    let i = importer(pool).await;
    let rows = console_hr_adapter_postgres::import::apply_job::SETTLE_CHUNK_ROWS + 1;
    let sheet = crate::rollback_burst::roster(rows, "사원");
    let run = i
        .preview("routed-job.xlsx", &[sheet], &Default::default())
        .await
        .unwrap()
        .run_id;
    let dry = i.dry_run(run, decisions()).await;
    i.apply(run, &dry.dry_run_digest).await.unwrap();
    operating(&i, true).await;
    let holders = console_hr_adapter_postgres::corrections::SecondPersonContext {
        other_eligible_holders: 1,
        routed: true,
        ..SOLO
    };
    let preview =
        i.f.hr
            .preview_import_rollback(i.f.principal.clone(), run)
            .await
            .unwrap();
    let requested =
        i.f.hr
            .rollback_import(
                i.f.principal.clone(),
                run,
                command(&preview.preview_digest),
                None,
                holders,
            )
            .await
            .unwrap();
    let mut decider = i.f.principal.clone();
    decider.user_id = console_kernel_core::UserId::new();
    sqlx::query("INSERT INTO users (id,display_name,roles,org_id) VALUES ($1,'결정자',ARRAY['SUPER_ADMIN'],$2)")
        .bind(decider.user_id.as_uuid()).bind(i.org()).execute(&i.owner).await.unwrap();
    let decision =
        serde_json::from_value(serde_json::json!({"decision":"APPLY","reason_code":"CONFIRMED"}))
            .unwrap();
    let approved =
        i.f.hr
            .decide_change_request(
                decider.clone(),
                requested.request_id.unwrap(),
                decision,
                holders,
            )
            .await
            .unwrap();
    assert_eq!(approved.status, "APPLIED");
    assert_eq!(
        i.f.hr
            .import_run(i.f.principal.clone(), run)
            .await
            .unwrap()
            .status,
        "ROLLBACK_RUNNING"
    );
    i.f.hr
        .drive_import_rollback(i.f.principal.org_id, run)
        .await
        .unwrap();
    let actors: (Uuid, Uuid, i64) = sqlx::query_as("SELECT rollback_requested_by,rolled_back_by, \
        (SELECT count(*) FROM employees WHERE org_id=$1 AND void_mode='GOVERNED' AND pii_destroyed_at IS NULL) \
        FROM data_import_runs WHERE org_id=$1 AND id=$2")
        .bind(i.org()).bind(run).fetch_one(&i.owner).await.unwrap();
    assert_eq!(
        actors,
        (
            *i.f.principal.user_id.as_uuid(),
            *decider.user_id.as_uuid(),
            rows as i64
        )
    );
}
