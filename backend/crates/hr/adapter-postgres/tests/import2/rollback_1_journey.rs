// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn setup_rollback_reverses_the_batch_and_retains_its_history(pool: PgPool) {
    use console_hr_adapter_postgres::import::rollback::RollbackRequest;
    let i = importer(pool).await;
    i.load(
        "undo.xlsx",
        &[table(
            "명부",
            0,
            &[
                &["사번", "성명", "입사일", "고용형태"],
                &["UNDO-01", "되돌림테스트", "2024-03-04", "정규직"],
            ],
        )],
        decisions(),
    )
    .await;
    let run: Uuid = sqlx::query_scalar(
        "SELECT id FROM data_import_runs WHERE org_id=$1 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(i.org())
    .fetch_one(&i.owner)
    .await
    .unwrap();
    let preview =
        i.f.hr
            .preview_import_rollback(i.f.principal.clone(), run)
            .await
            .unwrap();
    assert!(preview.blockers.is_empty());
    assert_eq!(preview.rows.len(), 1);
    let result =
        i.f.hr
            .rollback_import(
                i.f.principal.clone(),
                run,
                RollbackRequest {
                    preview_digest: preview.preview_digest,
                    acknowledged: true,
                    reason_code: None,
                    note: None,
                    step_up: None,
                },
                None,
                console_hr_adapter_postgres::corrections::SecondPersonContext {
                    other_eligible_holders: 0,
                    sole_holder_refuse: false,
                    routed: false,
                },
            )
            .await
            .unwrap();
    assert_eq!(result.status, "ROLLED_BACK");
    let record = i.f.hr.import_run(i.f.principal.clone(), run).await.unwrap();
    assert_eq!(record.status, "ROLLED_BACK");
    let hidden: (String, bool, String) = sqlx::query_as("SELECT employment_status, pii_destroyed_at IS NOT NULL, employee_number FROM employees WHERE org_id=$1 AND source_key LIKE $2")
        .bind(i.org()).bind(format!("run:{run}|%" )).fetch_one(&i.owner).await.unwrap();
    assert_eq!(hidden, ("VOIDED".into(), true, "UNDO-01".into()));
    let audits: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id=$1 AND target_id=$2 AND action='data_import.rollback'")
        .bind(i.org()).bind(run.to_string()).fetch_one(&i.owner).await.unwrap();
    assert_eq!(audits, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rollback_refusals_write_nothing(pool: PgPool) {
    use console_hr_adapter_postgres::import::rollback::RollbackRequest;
    let i = importer(pool).await;
    i.load(
        "guard.xlsx",
        &[table(
            "명부",
            0,
            &[
                &["사번", "성명", "입사일"],
                &["GUARD-01", "거절테스트", "2024-03-04"],
            ],
        )],
        decisions(),
    )
    .await;
    let run: Uuid = sqlx::query_scalar(
        "SELECT id FROM data_import_runs WHERE org_id=$1 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(i.org())
    .fetch_one(&i.owner)
    .await
    .unwrap();
    let preview =
        i.f.hr
            .preview_import_rollback(i.f.principal.clone(), run)
            .await
            .unwrap();
    for (digest, acknowledged, code) in [
        (
            preview.preview_digest.as_str(),
            false,
            "import_rollback_ack_required",
        ),
        ("stale", true, "rows_changed_since_preview"),
    ] {
        let err =
            i.f.hr
                .rollback_import(
                    i.f.principal.clone(),
                    run,
                    RollbackRequest {
                        preview_digest: digest.into(),
                        acknowledged,
                        reason_code: None,
                        note: None,
                        step_up: None,
                    },
                    None,
                    console_hr_adapter_postgres::corrections::SecondPersonContext {
                        other_eligible_holders: 0,
                        sole_holder_refuse: false,
                        routed: false,
                    },
                )
                .await
                .unwrap_err();
        assert_eq!(err.code, code);
        assert_eq!(
            i.f.hr
                .import_run(i.f.principal.clone(), run)
                .await
                .unwrap()
                .status,
            "APPLIED"
        );
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rollback_unknown_unapplied_and_predates_ledger_are_atomic(pool: PgPool) {
    let i = importer(pool).await;
    assert_refused(
        &i,
        Uuid::new_v4(),
        command("unused"),
        SOLO,
        404,
        "import_run_not_found",
    )
    .await;
    let run = i
        .preview(
            "unapplied.xlsx",
            &[table(
                "명부",
                0,
                &[
                    &["사번", "성명", "입사일"],
                    &["NOT-01", "미적용", "2024-03-04"],
                ],
            )],
            &Default::default(),
        )
        .await
        .unwrap()
        .run_id;
    assert_refused(
        &i,
        run,
        command("unused"),
        SOLO,
        409,
        "import_run_not_applied",
    )
    .await;
    i.dry_run(run, decisions()).await;
    assert_refused(
        &i,
        run,
        command("unused"),
        SOLO,
        409,
        "import_run_not_applied",
    )
    .await;
    let run = applied(&i).await;
    sqlx::query(
        "UPDATE data_import_runs SET rollback_ledger_complete=false WHERE org_id=$1 AND id=$2",
    )
    .bind(i.org())
    .bind(run)
    .execute(&i.owner)
    .await
    .unwrap();
    assert_refused(
        &i,
        run,
        command("unused"),
        SOLO,
        409,
        "import_run_predates_ledger",
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rollback_setup_ack_digest_and_already_rolled_back_refuse_without_mutation(pool: PgPool) {
    let i = importer(pool).await;
    let run = applied(&i).await;
    let preview =
        i.f.hr
            .preview_import_rollback(i.f.principal.clone(), run)
            .await
            .unwrap();
    let mut body = command(&preview.preview_digest);
    body.acknowledged = false;
    assert_refused(&i, run, body, SOLO, 422, "import_rollback_ack_required").await;
    assert_refused(
        &i,
        run,
        command("stale"),
        SOLO,
        409,
        "rows_changed_since_preview",
    )
    .await;
    i.f.hr
        .rollback_import(
            i.f.principal.clone(),
            run,
            command(&preview.preview_digest),
            None,
            SOLO,
        )
        .await
        .unwrap();
    assert_refused(
        &i,
        run,
        command(&preview.preview_digest),
        SOLO,
        409,
        "import_run_already_rolled_back",
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rollback_operating_reason_and_missing_step_up_refuse_without_mutation(pool: PgPool) {
    let i = importer(pool).await;
    let run = applied(&i).await;
    operating(&i, false).await;
    let preview =
        i.f.hr
            .preview_import_rollback(i.f.principal.clone(), run)
            .await
            .unwrap();
    for reason in [None, Some("NOT_A_REASON"), Some("OTHER")] {
        let mut body = command(&preview.preview_digest);
        body.reason_code = reason.map(str::to_owned);
        assert_refused(&i, run, body, SOLO, 422, "reason_code").await;
    }
    assert_refused(
        &i,
        run,
        command(&preview.preview_digest),
        SOLO,
        401,
        "step_up_required",
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rollback_window_closed_does_not_mutate_the_run(pool: PgPool) {
    let i = importer(pool).await;
    let run = applied(&i).await;
    operating(&i, false).await;
    let mut tx = i.owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(i.org().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SET LOCAL ROLE console_leave_definer")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query(
        "UPDATE data_import_runs SET applied_at=now()-interval '31 days' WHERE org_id=$1 AND id=$2",
    )
    .bind(i.org())
    .bind(run)
    .execute(tx.as_mut())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_refused(
        &i,
        run,
        command("unused"),
        SOLO,
        409,
        "import_rollback_window_closed",
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rollback_routed_request_is_pending_and_the_requester_cannot_decide(pool: PgPool) {
    use console_hr_adapter_postgres::corrections::SecondPersonContext;
    let i = importer(pool).await;
    let run = applied(&i).await;
    operating(&i, true).await;
    let preview =
        i.f.hr
            .preview_import_rollback(i.f.principal.clone(), run)
            .await
            .unwrap();
    assert_refused(
        &i,
        run,
        command(&preview.preview_digest),
        SecondPersonContext {
            sole_holder_refuse: true,
            routed: true,
            ..SOLO
        },
        403,
        "import_rollback_sole_holder_refused",
    )
    .await;
    let second = SecondPersonContext {
        other_eligible_holders: 1,
        routed: true,
        ..SOLO
    };
    let requested =
        i.f.hr
            .rollback_import(
                i.f.principal.clone(),
                run,
                command(&preview.preview_digest),
                None,
                second,
            )
            .await
            .unwrap();
    assert_eq!(requested.status, "ROLLBACK_REQUESTED");
    assert_refused(
        &i,
        run,
        command(&preview.preview_digest),
        second,
        409,
        "import_rollback_pending",
    )
    .await;
    let before = unchanged_snapshot(&i).await;
    let decide =
        serde_json::from_value(serde_json::json!({"decision":"APPLY","reason_code":"CONFIRMED"}))
            .unwrap();
    let err =
        i.f.hr
            .decide_change_request(
                i.f.principal.clone(),
                requested.request_id.unwrap(),
                decide,
                second,
            )
            .await
            .unwrap_err();
    assert_eq!(
        (err.status.as_u16(), err.code),
        (403, "authz_sod_requester")
    );
    assert_eq!(unchanged_snapshot(&i).await, before);
}
