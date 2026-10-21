// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rollback_same_idempotency_key_replays_the_original_outcome_without_writes(pool: PgPool) {
    use console_hr_adapter_postgres::import::rollback::RollbackCredentials;
    let i = importer(pool).await;
    let run = applied(&i).await;
    let preview =
        i.f.hr
            .preview_import_rollback(i.f.principal.clone(), run)
            .await
            .unwrap();
    let key = Uuid::new_v4().to_string();
    let first =
        i.f.hr
            .rollback_import(
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
    let before = unchanged_snapshot(&i).await;
    let replay =
        i.f.hr
            .rollback_import(
                i.f.principal.clone(),
                run,
                command(&preview.preview_digest),
                Some(RollbackCredentials {
                    passkeys: None,
                    idempotency_key: key,
                }),
                SOLO,
            )
            .await
            .unwrap();
    assert_eq!(
        serde_json::to_value(replay).unwrap(),
        serde_json::to_value(first).unwrap()
    );
    assert_eq!(unchanged_snapshot(&i).await, before);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rollback_keeps_unrelated_later_corrections_but_blocks_a_same_value_ledger_on_its_field(
    pool: PgPool,
) {
    use console_platform_test_support::soft_passkey::passkey_service;
    use time::{OffsetDateTime, format_description::well_known::Rfc3339};
    for same_field in [false, true] {
        let i = importer(pool.clone()).await;
        let (run, employee) = updated_job_run(&i, None).await;
        let version: OffsetDateTime =
            sqlx::query_scalar("SELECT updated_at FROM employees WHERE org_id=$1 AND id=$2")
                .bind(i.org())
                .bind(employee)
                .fetch_one(&i.owner)
                .await
                .unwrap();
        let changes = if same_field {
            serde_json::json!({"job":"품질 관리"})
        } else {
            serde_json::json!({"work_email":"rollback-fixture@example.test"})
        };
        let correction = serde_json::from_value(
            serde_json::json!({"expected_updated_at":version.format(&Rfc3339).unwrap(),
            "changes":changes,"reason_code":"DATA_ENTRY_ERROR"}),
        )
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
        let preview =
            i.f.hr
                .preview_import_rollback(i.f.principal.clone(), run)
                .await
                .unwrap();
        if same_field {
            assert!(
                preview
                    .blockers
                    .iter()
                    .any(|b| serde_json::to_value(b).unwrap()["kind"] == "changed_since")
            );
            assert_refused(
                &i,
                run,
                command(&preview.preview_digest),
                SOLO,
                409,
                "import_rollback_blocked",
            )
            .await;
        } else {
            assert!(
                preview.blockers.is_empty(),
                "unrelated field must survive: {:?}",
                preview.blockers
            );
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
            let values: (String, String) =
                sqlx::query_as("SELECT job,work_email FROM employees WHERE org_id=$1 AND id=$2")
                    .bind(i.org())
                    .bind(employee)
                    .fetch_one(&i.owner)
                    .await
                    .unwrap();
            assert_eq!(
                values,
                ("설비 관리".into(), "rollback-fixture@example.test".into())
            );
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rollback_job_text_restores_the_existing_catalog_binding(pool: PgPool) {
    let i = importer(pool).await;
    let catalog: Uuid = sqlx::query_scalar("INSERT INTO job_titles (org_id,kind,label,created_by) VALUES ($1,'JOB','설비 관리',$2) RETURNING id")
        .bind(i.org()).bind(*i.f.principal.user_id.as_uuid()).fetch_one(&i.owner).await.unwrap();
    let (run, employee) = updated_job_run(&i, Some(catalog)).await;
    let preview =
        i.f.hr
            .preview_import_rollback(i.f.principal.clone(), run)
            .await
            .unwrap();
    assert!(preview.blockers.is_empty(), "{:?}", preview.blockers);
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
    let restored: (String, Option<Uuid>) =
        sqlx::query_as("SELECT job,job_id FROM employees WHERE org_id=$1 AND id=$2")
            .bind(i.org())
            .bind(employee)
            .fetch_one(&i.owner)
            .await
            .unwrap();
    assert_eq!(restored, ("설비 관리".into(), Some(catalog)));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rollback_lifo_allows_the_earlier_run_after_the_later_run_is_reversed(pool: PgPool) {
    let i = importer(pool).await;
    let first = applied(&i).await;
    let second = i
        .preview(
            "later-position.xlsx",
            &[table(
                "명부",
                0,
                &[
                    &["사번", "성명", "입사일", "직위"],
                    &["NEG-01", "거절가", "2024-03-04", "대리"],
                ],
            )],
            &Default::default(),
        )
        .await
        .unwrap()
        .run_id;
    let dry = i.dry_run(second, decisions()).await;
    i.apply(second, &dry.dry_run_digest).await.unwrap();
    let earlier =
        i.f.hr
            .preview_import_rollback(i.f.principal.clone(), first)
            .await
            .unwrap();
    assert!(
        earlier
            .blockers
            .iter()
            .any(|b| serde_json::to_value(b).unwrap()["kind"] == "later_run")
    );
    assert_refused(
        &i,
        first,
        command(&earlier.preview_digest),
        SOLO,
        409,
        "import_rollback_blocked",
    )
    .await;
    let later =
        i.f.hr
            .preview_import_rollback(i.f.principal.clone(), second)
            .await
            .unwrap();
    assert!(later.blockers.is_empty(), "{:?}", later.blockers);
    i.f.hr
        .rollback_import(
            i.f.principal.clone(),
            second,
            command(&later.preview_digest),
            None,
            SOLO,
        )
        .await
        .unwrap();
    let earlier =
        i.f.hr
            .preview_import_rollback(i.f.principal.clone(), first)
            .await
            .unwrap();
    assert!(
        earlier.blockers.is_empty(),
        "a reversed later run must not become a permanent dependency: {:?}",
        earlier.blockers
    );
    i.f.hr
        .rollback_import(
            i.f.principal.clone(),
            first,
            command(&earlier.preview_digest),
            None,
            SOLO,
        )
        .await
        .unwrap();
    for run in [first, second] {
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

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_later_edit_to_a_run_created_profile_is_never_deleted(pool: PgPool) {
    let i = importer(pool).await;
    let (_, employee) = updated_job_run(&i, None).await;
    let run = i
        .preview(
            "profile.xlsx",
            &[table(
                "명부",
                0,
                &[
                    &["사번", "성명", "입사일", "종사 업무", "고용형태"],
                    &["JOB-01", "수정가", "2024-03-04", "품질 관리", "정규직"],
                ],
            )],
            &Default::default(),
        )
        .await
        .unwrap()
        .run_id;
    let dry = i.dry_run(run, decisions()).await;
    i.apply(run, &dry.dry_run_digest).await.unwrap();
    sqlx::query("UPDATE employee_employment_profiles SET phone_e164='+821012345678' WHERE org_id=$1 AND employee_id=$2")
        .bind(i.org()).bind(employee).execute(&i.owner).await.unwrap();
    let preview =
        i.f.hr
            .preview_import_rollback(i.f.principal.clone(), run)
            .await
            .unwrap();
    assert!(
        preview
            .blockers
            .iter()
            .any(|b| b.kind == console_hr_domain::import::rollback::BlockerKind::ChangedSince)
    );
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
