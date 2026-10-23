// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
pub(super) const SOLO: console_hr_adapter_postgres::corrections::SecondPersonContext =
    console_hr_adapter_postgres::corrections::SecondPersonContext {
        other_eligible_holders: 0,
        sole_holder_refuse: false,
        routed: false,
    };

pub(super) fn command(
    digest: &str,
) -> console_hr_adapter_postgres::import::rollback::RollbackRequest {
    console_hr_adapter_postgres::import::rollback::RollbackRequest {
        preview_digest: digest.into(),
        acknowledged: true,
        reason_code: Some("WRONG_FILE".into()),
        note: None,
        step_up: None,
    }
}

pub(super) async fn applied(i: &crate::harness::Importer) -> Uuid {
    let run = i
        .preview(
            "negative.xlsx",
            &[table(
                "명부",
                0,
                &[
                    &["사번", "성명", "입사일", "고용형태"],
                    &["NEG-01", "거절가", "2024-03-04", "정규직"],
                ],
            )],
            &Default::default(),
        )
        .await
        .unwrap()
        .run_id;
    let dry = i.dry_run(run, decisions()).await;
    i.apply(run, &dry.dry_run_digest).await.unwrap();
    run
}

/// Compare contents as well as counts, including every employee's updated_at.
pub(super) async fn unchanged_snapshot(i: &crate::harness::Importer) -> serde_json::Value {
    let mut snapshot = serde_json::Map::new();
    for table in [
        "employees",
        "employee_employment_profiles",
        "employment_assignments",
        "employment_heads",
        "employment_revisions",
        "employment_source_bindings",
        "employee_lifecycle_events",
        "employee_rrn",
        "employee_register_facts",
        "employee_corrections",
        "import_run_row_snapshots",
        "import_run_effects",
        "data_import_rows",
        "data_import_runs",
        "change_requests",
        "audit_events",
    ] {
        let sql = format!(
            "SELECT COALESCE(jsonb_agg(v ORDER BY v::TEXT), '[]'::JSONB) FROM (SELECT to_jsonb(t) AS v FROM {table} t WHERE org_id=$1) AS records"
        );
        let rows: serde_json::Value = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
            .bind(i.org())
            .fetch_one(&i.owner)
            .await
            .unwrap();
        snapshot.insert(table.into(), rows);
    }
    snapshot.into()
}

pub(super) async fn operating(i: &crate::harness::Importer, routed: bool) {
    let mut tx = i.owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(i.org().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE tenant_phase SET phase='OPERATING' WHERE org_id=$1")
        .bind(i.org())
        .execute(tx.as_mut())
        .await
        .unwrap();
    if routed {
        // Backdate the synthetic setting so every transaction sees the same policy.
        sqlx::query("SET LOCAL session_replication_role = replica")
            .execute(tx.as_mut())
            .await
            .unwrap();
        sqlx::query("INSERT INTO tenant_setting_overrides (org_id,key,value,set_by,reason_code,effective_from) VALUES ($1,'approval.policy.import_rollback','\"route\"',$2,'TEST',now()-interval '1 day')")
            .bind(i.org()).bind(*i.f.principal.user_id.as_uuid()).execute(tx.as_mut()).await.unwrap();
    }
    tx.commit().await.unwrap();
}

pub(super) async fn assert_refused(
    i: &crate::harness::Importer,
    run: Uuid,
    body: console_hr_adapter_postgres::import::rollback::RollbackRequest,
    holders: console_hr_adapter_postgres::corrections::SecondPersonContext,
    status: u16,
    code: &str,
) {
    let before = unchanged_snapshot(i).await;
    let err =
        i.f.hr
            .rollback_import(i.f.principal.clone(), run, body, None, holders)
            .await
            .unwrap_err();
    assert_eq!((err.status.as_u16(), err.code), (status, code));
    assert_eq!(unchanged_snapshot(i).await, before, "{code} must be atomic");
}

pub(super) async fn signed_step_up(
    i: &crate::harness::Importer,
    key: &mut console_platform_test_support::soft_passkey::SoftKey,
    binding: console_platform_auth::MobilePasskeyStepUpBinding,
) -> console_platform_auth::MobilePasskeyStepUpEnvelope {
    let start = console_platform_test_support::soft_passkey::passkey_service()
        .start_mobile_step_up(&i.owner, *i.f.principal.user_id.as_uuid(), binding.clone())
        .await
        .unwrap();
    let mut challenge = serde_json::to_value(start.challenge).unwrap();
    challenge["publicKey"]["allowCredentials"] =
        serde_json::json!([{"type":"public-key","id":key.credential_id()}]);
    serde_json::from_value(serde_json::json!({"binding":binding,"assertion":{
        "ceremony_id":start.ceremony_id,"credential":key.assert(&challenge).unwrap(),
    }}))
    .unwrap()
}

pub(super) async fn updated_job_run(
    i: &crate::harness::Importer,
    catalog: Option<Uuid>,
) -> (Uuid, Uuid) {
    i.load(
        "job-before.xlsx",
        &[table(
            "명부",
            0,
            &[
                &["사번", "성명", "입사일", "종사 업무"],
                &["JOB-01", "수정가", "2024-03-04", "설비 관리"],
            ],
        )],
        decisions(),
    )
    .await;
    let employee = i.person("수정가").await.0;
    if let Some(catalog) = catalog {
        sqlx::query("UPDATE employees SET job_id=$3 WHERE org_id=$1 AND id=$2")
            .bind(i.org())
            .bind(employee)
            .bind(catalog)
            .execute(&i.owner)
            .await
            .unwrap();
    }
    let run = i
        .preview(
            "job-after.xlsx",
            &[table(
                "명부",
                0,
                &[
                    &["사번", "성명", "입사일", "종사 업무"],
                    &["JOB-01", "수정가", "2024-03-04", "품질 관리"],
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
    assert_eq!((report.inserted, report.updated), (0, 1));
    (run, employee)
}
