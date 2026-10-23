// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rollback_dependency_kinds_block_the_entire_batch(pool: PgPool) {
    for kind in [
        "work_record",
        "changed_since",
        "account_linked",
        "later_run",
    ] {
        let i = importer(pool.clone()).await;
        let run = applied(&i).await;
        let employee = i.person("거절가").await.0;
        match kind {
            "work_record" => {
                sqlx::query("INSERT INTO employee_lifecycle_events (org_id,employee_id,event_type,effective_date,from_status,to_status,comment,created_by) SELECT org_id,id,'PROMOTE',hire_date,'ACTIVE','ACTIVE','test',$2 FROM employees WHERE id=$1")
                    .bind(employee).bind(*i.f.principal.user_id.as_uuid()).execute(&i.owner).await.unwrap();
            }
            "changed_since" => {
                sqlx::query("UPDATE employees SET position='과장',updated_at=clock_timestamp() WHERE org_id=$1 AND id=$2").bind(i.org()).bind(employee).execute(&i.owner).await.unwrap();
            }
            "account_linked" => {
                sqlx::query("UPDATE users SET employee_id=$1 WHERE id=$2")
                    .bind(employee)
                    .bind(*i.f.principal.user_id.as_uuid())
                    .execute(&i.owner)
                    .await
                    .unwrap();
            }
            "later_run" => {
                i.load(
                    "later.xlsx",
                    &[table(
                        "명부",
                        0,
                        &[
                            &["사번", "성명", "입사일", "직위"],
                            &["NEG-01", "거절가", "2024-03-04", "대리"],
                        ],
                    )],
                    decisions(),
                )
                .await;
            }
            _ => unreachable!(),
        }
        let preview =
            i.f.hr
                .preview_import_rollback(i.f.principal.clone(), run)
                .await
                .unwrap();
        let blockers = serde_json::to_value(&preview.blockers).unwrap();
        assert!(
            blockers
                .as_array()
                .unwrap()
                .iter()
                .any(|b| b["kind"] == kind),
            "{kind}: {blockers}"
        );
        assert!(preview.allowed.is_empty());
        assert_refused(
            &i,
            run,
            command(&preview.preview_digest),
            SOLO,
            409,
            "import_rollback_blocked",
        )
        .await;
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rollback_rechecks_a_changed_employee_after_preview(pool: PgPool) {
    use console_hr_domain::import::rollback::BlockerKind;
    use console_platform_test_support::soft_passkey::passkey_service;
    use time::{OffsetDateTime, format_description::well_known::Rfc3339};
    let i = importer(pool).await;
    let (run, employee) = updated_job_run(&i, None).await;
    let preview =
        i.f.hr
            .preview_import_rollback(i.f.principal.clone(), run)
            .await
            .unwrap();
    assert!(preview.blockers.is_empty());
    let version: OffsetDateTime =
        sqlx::query_scalar("SELECT updated_at FROM employees WHERE org_id=$1 AND id=$2")
            .bind(i.org())
            .bind(employee)
            .fetch_one(&i.owner)
            .await
            .unwrap();
    let correction = serde_json::from_value(serde_json::json!({
        "expected_updated_at": version.format(&Rfc3339).unwrap(),
        "changes": {"job": "생산 관리"}, "reason_code": "DATA_ENTRY_ERROR",
    }))
    .unwrap();
    i.f.hr
        .correct_employee(
            i.f.principal.clone(),
            &passkey_service(),
            employee,
            correction,
            SOLO,
        )
        .await
        .unwrap();
    let changed =
        i.f.hr
            .preview_import_rollback(i.f.principal.clone(), run)
            .await
            .unwrap();
    assert_eq!(changed.blockers.len(), 1, "{:?}", changed.blockers);
    let blocker = &changed.blockers[0];
    assert_eq!(blocker.employee_id, employee);
    assert_eq!(blocker.kind, BlockerKind::ChangedSince);
    assert_eq!(blocker.field.as_deref(), Some("job"));
    assert_ne!(changed.preview_digest, preview.preview_digest);
    assert_refused(
        &i,
        run,
        command(&preview.preview_digest),
        SOLO,
        409,
        "import_rollback_blocked",
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rollback_concurrent_commands_allow_only_one_transition(pool: PgPool) {
    let i = importer(pool).await;
    let run = applied(&i).await;
    let preview =
        i.f.hr
            .preview_import_rollback(i.f.principal.clone(), run)
            .await
            .unwrap();
    let (left, right) = tokio::join!(
        i.f.hr.rollback_import(
            i.f.principal.clone(),
            run,
            command(&preview.preview_digest),
            None,
            SOLO
        ),
        i.f.hr.rollback_import(
            i.f.principal.clone(),
            run,
            command(&preview.preview_digest),
            None,
            SOLO
        )
    );
    assert_eq!(usize::from(left.is_ok()) + usize::from(right.is_ok()), 1);
    let err = if let Err(e) = left {
        e
    } else {
        right.unwrap_err()
    };
    assert_eq!(err.code, "import_run_already_rolled_back");
    assert_eq!(
        i.count(
            "SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='data_import.rollback'"
        )
        .await,
        1
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rollback_database_guards_require_the_command_audit_and_append_only_provenance(
    pool: PgPool,
) {
    let i = importer(pool).await;
    let run = applied(&i).await;
    let before = unchanged_snapshot(&i).await;
    let schemas: (bool, bool) = sqlx::query_as("SELECT has_schema_privilege(current_user,'leave_api','USAGE'), has_schema_privilege(current_user,'import_api','USAGE')")
        .fetch_one(&i.f.rt).await.unwrap();
    assert_eq!(
        schemas,
        (false, true),
        "runtime must keep the leave capability isolated"
    );
    for sql in [
        "UPDATE data_import_runs SET status='ROLLED_BACK' WHERE org_id=$1 AND id=$2",
        "UPDATE import_run_effects SET created_at=clock_timestamp() WHERE org_id=$1 AND run_id=$2",
        "DELETE FROM import_run_effects WHERE org_id=$1 AND run_id=$2",
    ] {
        let mut tx = i.f.rt.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org',$1,true)")
            .bind(i.org().to_string())
            .execute(tx.as_mut())
            .await
            .unwrap();
        let err = sqlx::query(sqlx::AssertSqlSafe(sql.to_owned()))
            .bind(i.org())
            .bind(run)
            .execute(tx.as_mut())
            .await
            .unwrap_err();
        if sql.contains("data_import_runs") {
            assert!(
                err.to_string()
                    .contains("employee_import_run.command_required"),
                "{err}"
            );
        } else {
            assert_eq!(
                err.as_database_error().unwrap().code().as_deref(),
                Some("42501")
            );
        }
        tx.rollback().await.unwrap();
    }
    let mut tx = i.f.rt.begin().await.unwrap();
    let trace = console_kernel_core::TraceContext::generate();
    sqlx::query(
        "SELECT set_config('app.current_org',$1,true),set_config('app.current_user',$2,true)",
    )
    .bind(i.org().to_string())
    .bind(i.f.principal.user_id.to_string())
    .execute(tx.as_mut())
    .await
    .unwrap();
    sqlx::query("SELECT import_api.mark_employee_import_rolled_back($1,$2,$3,NULL,'IMPORT_ROLLBACK',NULL,$4,$5,$6)")
        .bind(i.org()).bind(run).bind(*i.f.principal.user_id.as_uuid()).bind(Uuid::new_v4()).bind(trace.trace_id()).bind(trace.span_id())
        .execute(tx.as_mut()).await.unwrap();
    let err = tx.commit().await.unwrap_err();
    assert!(
        err.to_string()
            .contains("employee_import_run.current_transaction_audit_required"),
        "{err}"
    );
    assert_eq!(unchanged_snapshot(&i).await, before);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rollback_operating_passkey_is_bound_to_the_run_and_retains_pii_until_purge(pool: PgPool) {
    use console_hr_adapter_postgres::import::rollback::{RollbackCredentials, rollback_binding};
    use console_platform_test_support::soft_passkey::{SoftKey, passkey_service};
    let i = importer(pool).await;
    let run = applied(&i).await;
    operating(&i, false).await;
    let preview =
        i.f.hr
            .preview_import_rollback(i.f.principal.clone(), run)
            .await
            .unwrap();
    let mut key = SoftKey::enroll(&i.owner, i.f.principal.org_id, i.f.principal.user_id).await;
    let mut body = command(&preview.preview_digest);
    body.step_up = Some(
        signed_step_up(
            &i,
            &mut key,
            rollback_binding(Uuid::new_v4(), &preview.preview_digest),
        )
        .await,
    );
    let before = unchanged_snapshot(&i).await;
    let err =
        i.f.hr
            .rollback_import(
                i.f.principal.clone(),
                run,
                body,
                Some(RollbackCredentials {
                    passkeys: Some(passkey_service()),
                    idempotency_key: Uuid::new_v4().to_string(),
                }),
                SOLO,
            )
            .await
            .unwrap_err();
    assert_eq!((err.status.as_u16(), err.code), (401, "step_up_failed"));
    assert_eq!(unchanged_snapshot(&i).await, before);
    let mut body = command(&preview.preview_digest);
    body.step_up =
        Some(signed_step_up(&i, &mut key, rollback_binding(run, &preview.preview_digest)).await);
    let outcome =
        i.f.hr
            .rollback_import(
                i.f.principal.clone(),
                run,
                body,
                Some(RollbackCredentials {
                    passkeys: Some(passkey_service()),
                    idempotency_key: Uuid::new_v4().to_string(),
                }),
                SOLO,
            )
            .await
            .unwrap();
    assert_eq!(outcome.status, "ROLLED_BACK");
    let state:(String,String,String,bool)=sqlx::query_as("SELECT employment_status,void_mode,employee_number,pii_destroyed_at IS NOT NULL FROM employees WHERE org_id=$1")
        .bind(i.org()).fetch_one(&i.owner).await.unwrap();
    assert_eq!(
        state,
        ("VOIDED".into(), "GOVERNED".into(), "NEG-01".into(), false)
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rollback_restores_updated_fields_and_removes_only_run_owned_side_effects(pool: PgPool) {
    let i = importer(pool).await;
    i.load(
        "before.xlsx",
        &[table(
            "명부",
            0,
            &[
                &["사번", "성명", "입사일", "직위"],
                &["OLD-01", "기존가", "2024-03-04", "사원"],
                &["OLD-02", "기존나", "2024-03-04", "사원"],
            ],
        )],
        decisions(),
    )
    .await;
    let old_ids = vec![i.person("기존가").await.0, i.person("기존나").await.0];
    let before:Vec<serde_json::Value>=sqlx::query_scalar("SELECT to_jsonb(e)-'updated_at' FROM employees e WHERE org_id=$1 AND id=ANY($2) ORDER BY id")
        .bind(i.org()).bind(&old_ids).fetch_all(&i.owner).await.unwrap();
    let run = i
        .preview(
            "mixed.xlsx",
            &[table(
                "명부",
                0,
                &[
                    &[
                        "사번",
                        "성명",
                        "입사일",
                        "직위",
                        "고용형태",
                        "주민등록번호",
                        "연락처",
                        "재직상태",
                        "휴직시작일",
                        "휴직구분",
                        "복직예정일",
                    ],
                    &[
                        "OLD-01",
                        "기존가",
                        "2024-03-04",
                        "대리",
                        "정규직",
                        "900101-1234567",
                        "",
                        "재직",
                        "",
                        "",
                        "",
                    ],
                    &[
                        "OLD-02",
                        "기존나",
                        "2024-03-04",
                        "과장",
                        "",
                        "",
                        "",
                        "재직",
                        "",
                        "",
                        "",
                    ],
                    &[
                        "NEW-01",
                        "예정가",
                        "2030-01-02",
                        "사원",
                        "정규직",
                        "",
                        "010-1234-5678",
                        "",
                        "",
                        "",
                        "",
                    ],
                    &[
                        "NEW-02",
                        "휴직가",
                        "2023-01-02",
                        "사원",
                        "정규직",
                        "850505-2234567",
                        "010-1234-5678",
                        "휴직",
                        "2026-03-02",
                        "육아휴직",
                        "2027-03-01",
                    ],
                ],
            )],
            &Default::default(),
        )
        .await
        .unwrap()
        .run_id;
    let dry = i.dry_run(run, decisions()).await;
    assert_eq!(dry.review.blocking, 0, "{:?}", dry.review.items);
    let report = i.apply(run, &dry.dry_run_digest).await.unwrap();
    assert_eq!((report.inserted, report.updated), (2, 2));
    let preview =
        i.f.hr
            .preview_import_rollback(i.f.principal.clone(), run)
            .await
            .unwrap();
    assert!(
        preview.blockers.is_empty(),
        "the run's own setup leave and ONBOARD are not dependencies: {:?}",
        preview.blockers
    );
    let history:(i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM employee_corrections WHERE org_id=$1 AND import_run_id=$2),(SELECT count(*) FROM data_import_rows WHERE org_id=$1 AND run_id=$2),(SELECT count(*) FROM import_run_row_snapshots WHERE org_id=$1 AND run_id=$2)")
        .bind(i.org()).bind(run).fetch_one(&i.owner).await.unwrap();
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
    let after:Vec<serde_json::Value>=sqlx::query_scalar("SELECT to_jsonb(e)-'updated_at' FROM employees e WHERE org_id=$1 AND id=ANY($2) ORDER BY id")
        .bind(i.org()).bind(&old_ids).fetch_all(&i.owner).await.unwrap();
    assert_eq!(after, before);
    for (effect, table_name) in [
        ("profile_created", "employee_employment_profiles"),
        ("rrn_recorded", "employee_rrn"),
        ("register_fact", "employee_register_facts"),
    ] {
        let sql = format!(
            "SELECT count(*) FROM {table_name} t JOIN import_run_effects f ON f.org_id=t.org_id AND f.employee_id=t.employee_id WHERE f.org_id=$1 AND f.run_id=$2 AND f.effect=$3"
        );
        let remaining: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
            .bind(i.org())
            .bind(run)
            .bind(effect)
            .fetch_one(&i.owner)
            .await
            .unwrap();
        assert_eq!(remaining, 0, "{effect}");
    }
    let inserted:Vec<(String,bool,String)>=sqlx::query_as("SELECT e.employment_status,e.pii_destroyed_at IS NOT NULL,e.employee_number FROM employees e JOIN import_run_row_snapshots s ON s.org_id=e.org_id AND s.employee_id=e.id WHERE s.org_id=$1 AND s.run_id=$2 AND s.outcome='INSERTED' ORDER BY employee_number")
        .bind(i.org()).bind(run).fetch_all(&i.owner).await.unwrap();
    assert_eq!(
        inserted,
        vec![
            ("VOIDED".into(), true, "NEW-01".into()),
            ("VOIDED".into(), true, "NEW-02".into())
        ]
    );
    let restored:i64=sqlx::query_scalar("SELECT count(*) FROM employee_corrections WHERE org_id=$1 AND import_run_id=$2 AND reason_code='IMPORT_ROLLBACK'")
        .bind(i.org()).bind(run).fetch_one(&i.owner).await.unwrap();
    assert!(restored >= 2);
    let after_history:(i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM employee_corrections WHERE org_id=$1 AND import_run_id=$2),(SELECT count(*) FROM data_import_rows WHERE org_id=$1 AND run_id=$2),(SELECT count(*) FROM import_run_row_snapshots WHERE org_id=$1 AND run_id=$2)")
        .bind(i.org()).bind(run).fetch_one(&i.owner).await.unwrap();
    assert_eq!(after_history, (history.0 + restored, history.1, history.2));
    let open_assignments:i64=sqlx::query_scalar("SELECT count(*) FROM employment_assignments a JOIN import_run_effects f ON f.org_id=a.org_id AND f.target_id=a.id WHERE f.org_id=$1 AND f.run_id=$2 AND f.effect='placed' AND a.superseded_at IS NULL")
        .bind(i.org()).bind(run).fetch_one(&i.owner).await.unwrap();
    assert_eq!(open_assignments, 0);
}
