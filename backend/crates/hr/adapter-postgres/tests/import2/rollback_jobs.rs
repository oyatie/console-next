// SPDX-License-Identifier: LicenseRef-Proprietary
//! Accepted reversals survive driver loss, recheck dependencies, and publish terminal state.
use super::*;
use console_hr_adapter_postgres::import::rollback::RollbackCredentials;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn accepted_job_is_recovered_and_replay_never_reverses_twice(pool: PgPool) {
    let i = importer(pool).await;
    let run = applied(&i).await;
    let preview =
        i.f.hr
            .preview_import_rollback(i.f.principal.clone(), run)
            .await
            .unwrap();
    let key = Uuid::new_v4().to_string();
    for _ in 0..2 {
        let accepted =
            i.f.hr
                .start_import_rollback(
                    i.f.principal.clone(),
                    run,
                    command(&preview.preview_digest),
                    Some(RollbackCredentials {
                        passkeys: None,
                        idempotency_key: key.clone(),
                    }),
                    SOLO,
                )
                .await
                .unwrap();
        assert_eq!(accepted.status, "ROLLBACK_RUNNING");
    }
    let running = i.f.hr.import_run(i.f.principal.clone(), run).await.unwrap();
    assert_eq!(running.status, "ROLLBACK_RUNNING");
    assert!(
        running.allowed.is_empty(),
        "running jobs offer no rollback actions"
    );
    assert_refused(
        &i,
        run,
        command(&preview.preview_digest),
        SOLO,
        409,
        "import_rollback_pending",
    )
    .await;
    // A new service instance represents a process that lost its in-memory driver.
    let recovered = console_hr_adapter_postgres::HrService::new(i.f.rt.clone());
    assert_eq!(recovered.resume_import_rollbacks().await.unwrap(), 1);
    assert_eq!(recovered.resume_import_rollbacks().await.unwrap(), 0);
    let current = recovered
        .import_run(i.f.principal.clone(), run)
        .await
        .unwrap();
    assert_eq!(current.status, "ROLLED_BACK");
    assert_eq!(current.rollback.job.unwrap().state, "done");
    let frames: Vec<String> = sqlx::query_scalar(
        "SELECT a.action FROM resource_changes c JOIN audit_events a ON a.id=c.audit_event_id \
        WHERE c.org_id=$1 AND c.resource_type='import_run' AND c.resource_id=$2 \
        AND a.action IN ('data_import.rollback.progress','data_import.rollback') ORDER BY c.seq",
    )
    .bind(i.org())
    .bind(run.to_string())
    .fetch_all(&i.owner)
    .await
    .unwrap();
    assert_eq!(
        frames,
        ["data_import.rollback.progress", "data_import.rollback"]
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn job_dependency_recheck_stores_a_refusal_without_reversing_any_person(pool: PgPool) {
    let i = importer(pool).await;
    let run = applied(&i).await;
    let preview =
        i.f.hr
            .preview_import_rollback(i.f.principal.clone(), run)
            .await
            .unwrap();
    i.f.hr
        .start_import_rollback(
            i.f.principal.clone(),
            run,
            command(&preview.preview_digest),
            None,
            SOLO,
        )
        .await
        .unwrap();
    sqlx::query(
        "UPDATE employees SET position='과장',updated_at=clock_timestamp() WHERE org_id=$1",
    )
    .bind(i.org())
    .execute(&i.owner)
    .await
    .unwrap();
    let mut before = unchanged_snapshot(&i).await;
    let err =
        i.f.hr
            .drive_import_rollback(i.f.principal.org_id, run)
            .await
            .unwrap_err();
    assert_eq!(err.code, "import_rollback_blocked");
    let mut after = unchanged_snapshot(&i).await;
    // Only the job and its refusal audit change; every personnel/history table is untouched.
    for snapshot in [&mut before, &mut after] {
        snapshot.as_object_mut().unwrap().remove("data_import_runs");
        snapshot.as_object_mut().unwrap().remove("audit_events");
    }
    assert_eq!(before, after);
    let current = i.f.hr.import_run(i.f.principal.clone(), run).await.unwrap();
    assert_eq!(current.status, "APPLIED");
    let job = current.rollback.job.unwrap();
    assert_eq!(job.state, "failed");
    assert_eq!(job.error.unwrap()["code"], "import_rollback_blocked");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn setup_job_cannot_bypass_operating_governance_after_a_phase_change(pool: PgPool) {
    let i = importer(pool).await;
    let run = applied(&i).await;
    let preview =
        i.f.hr
            .preview_import_rollback(i.f.principal.clone(), run)
            .await
            .unwrap();
    i.f.hr
        .start_import_rollback(
            i.f.principal.clone(),
            run,
            command(&preview.preview_digest),
            None,
            SOLO,
        )
        .await
        .unwrap();
    operating(&i, false).await;
    let err =
        i.f.hr
            .drive_import_rollback(i.f.principal.org_id, run)
            .await
            .unwrap_err();
    assert_eq!(err.code, "rows_changed_since_preview");
    let voided: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM employees WHERE org_id=$1 AND voided_at IS NOT NULL",
    )
    .bind(i.org())
    .fetch_one(&i.owner)
    .await
    .unwrap();
    assert_eq!(voided, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn routed_decision_uses_filing_time_and_rechecks_a_later_correction(pool: PgPool) {
    use console_hr_adapter_postgres::corrections::SecondPersonContext;
    use console_platform_test_support::soft_passkey::passkey_service;
    use time::format_description::well_known::Rfc3339;
    for corrected in [false, true] {
        let i = importer(pool.clone()).await;
        let (run, employee) = updated_job_run(&i, None).await;
        operating(&i, true).await;
        let holders = SecondPersonContext {
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
        let request = requested.request_id.unwrap();
        let mut decider = i.f.principal.clone();
        decider.user_id = console_kernel_core::UserId::new();
        sqlx::query("INSERT INTO users (id,display_name,roles,org_id) VALUES ($1,'결정자',ARRAY['SUPER_ADMIN'],$2)")
            .bind(decider.user_id.as_uuid()).bind(i.org()).execute(&i.owner).await.unwrap();
        if corrected {
            let version: time::OffsetDateTime =
                sqlx::query_scalar("SELECT updated_at FROM employees WHERE org_id=$1 AND id=$2")
                    .bind(i.org())
                    .bind(employee)
                    .fetch_one(&i.owner)
                    .await
                    .unwrap();
            let body = serde_json::from_value(
                serde_json::json!({"expected_updated_at":version.format(&Rfc3339).unwrap(),
                "changes":{"job":"후속 정정"},"reason_code":"DATA_ENTRY_ERROR"}),
            )
            .unwrap();
            i.f.hr
                .correct_employee(
                    i.f.principal.clone(),
                    &passkey_service(),
                    employee,
                    body,
                    SOLO,
                )
                .await
                .unwrap();
        } else {
            // Move both synthetic instants together: filing was in-window, decision is after it.
            let mut tx = i.owner.begin().await.unwrap();
            sqlx::query("SET LOCAL session_replication_role=replica")
                .execute(tx.as_mut())
                .await
                .unwrap();
            sqlx::query("UPDATE data_import_runs SET applied_at=applied_at-interval '31 days' WHERE org_id=$1")
                .bind(i.org()).execute(tx.as_mut()).await.unwrap();
            sqlx::query("UPDATE change_requests SET created_at=now()-interval '30 days' WHERE org_id=$1 AND id=$2")
                .bind(i.org()).bind(request).execute(tx.as_mut()).await.unwrap();
            tx.commit().await.unwrap();
        }
        let before = unchanged_snapshot(&i).await;
        let decision = serde_json::from_value(
            serde_json::json!({"decision":"APPLY","reason_code":"CONFIRMED"}),
        )
        .unwrap();
        let result =
            i.f.hr
                .decide_change_request(decider, request, decision, holders)
                .await;
        if corrected {
            assert_eq!(result.unwrap_err().code, "import_rollback_blocked");
            assert_eq!(unchanged_snapshot(&i).await, before);
        } else {
            result.unwrap();
            assert_eq!(
                i.f.hr
                    .import_run(i.f.principal.clone(), run)
                    .await
                    .unwrap()
                    .status,
                "ROLLED_BACK"
            );
        }
    }
}
