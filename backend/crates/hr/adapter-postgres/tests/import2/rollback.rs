// SPDX-License-Identifier: LicenseRef-Proprietary
//! The immutable record used by the rollback result screen.

use console_hr_adapter_postgres::import::run_record::RunListQuery;
use console_hr_domain::import::detect::WorkbookMappingRequest;
use console_kernel_core::BranchScope;
use console_platform_authz::{EffectiveFeatureGrant, Feature, PermissionLevel, Principal, Role};
use sqlx::PgPool;
use uuid::Uuid;

use crate::harness::{decisions, importer, table};

#[path = "rollback_support.rs"]
mod support;
use support::*;
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn run_record_keeps_the_stored_counts_after_an_imported_person_exits(pool: PgPool) {
    let i = importer(pool).await;
    let sheet = table(
        "명부",
        0,
        &[
            &["사번", "성명", "입사일", "고용형태"],
            &["RB-01", "가테스트", "2024-03-04", "정규직"],
            &["RB-02", "나테스트", "2024-03-04", "정규직"],
        ],
    );
    let run = i
        .preview(
            "rollback-record.xlsx",
            &[sheet],
            &WorkbookMappingRequest::default(),
        )
        .await
        .unwrap()
        .run_id;
    let plan = i.dry_run(run, decisions()).await;
    let unapplied = i.f.hr.import_run(i.f.principal.clone(), run).await.unwrap();
    assert_eq!(unapplied.status, "DRY_RUN");
    assert!(unapplied.apply_summary.is_none());
    i.apply(run, &plan.dry_run_digest).await.unwrap();
    let before = i.f.hr.import_run(i.f.principal.clone(), run).await.unwrap();
    assert_eq!(before.source_filename, "rollback-record.xlsx");
    assert_eq!(
        before.applied_by.as_ref().unwrap().id,
        *i.f.principal.user_id.as_uuid()
    );
    assert!(before.applied_at.is_some());
    assert_eq!(before.apply_summary.as_ref().unwrap()["inserted"], 2);
    let person = i.person("가테스트").await.0;
    sqlx::query("UPDATE employees SET employment_status = 'EXITED', exit_date = '2026-10-21', updated_at = clock_timestamp() WHERE org_id = $1 AND id = $2")
        .bind(i.org()).bind(person).execute(&i.owner).await.unwrap();
    let after = i.f.hr.import_run(i.f.principal.clone(), run).await.unwrap();
    assert_eq!(
        serde_json::to_value(&before).unwrap(),
        serde_json::to_value(&after).unwrap()
    );
    let page =
        i.f.hr
            .import_runs(i.f.principal.clone(), RunListQuery::default())
            .await
            .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].apply_summary, before.apply_summary);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn recent_run_pages_do_not_repeat_and_malformed_queries_are_refused(pool: PgPool) {
    let i = importer(pool).await;
    for (number, name) in [("RB-04", "라테스트"), ("RB-05", "마테스트")] {
        i.load(
            "page.xlsx",
            &[table(
                "명부",
                0,
                &[
                    &["사번", "성명", "입사일", "고용형태"],
                    &[number, name, "2024-03-04", "정규직"],
                ],
            )],
            decisions(),
        )
        .await;
    }
    let first =
        i.f.hr
            .import_runs(
                i.f.principal.clone(),
                RunListQuery {
                    limit: Some(1),
                    after: None,
                },
            )
            .await
            .unwrap();
    let next = first.next_cursor.clone().unwrap();
    let second =
        i.f.hr
            .import_runs(
                i.f.principal.clone(),
                RunListQuery {
                    limit: Some(1),
                    after: Some(next),
                },
            )
            .await
            .unwrap();
    assert_eq!((first.items.len(), second.items.len()), (1, 1));
    assert_ne!(first.items[0].id, second.items[0].id);
    assert!(second.next_cursor.is_none());
    for query in [
        RunListQuery {
            limit: Some(0),
            after: None,
        },
        RunListQuery {
            limit: None,
            after: Some("not-a-cursor".into()),
        },
    ] {
        assert_eq!(
            i.f.hr
                .import_runs(i.f.principal.clone(), query)
                .await
                .unwrap_err()
                .status
                .as_u16(),
            422
        );
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_applied_run_is_not_completed_history_until_its_job_finishes(pool: PgPool) {
    let i = importer(pool).await;
    let (run, digest) = crate::mig_job::staged(&i, 1).await;
    i.apply(run, &digest).await.unwrap();
    for state in ["settling", "failed"] {
        sqlx::query("UPDATE data_import_runs SET apply_job = jsonb_set(COALESCE(apply_job, '{}'::jsonb), '{state}', to_jsonb($2::TEXT)) WHERE org_id = $1 AND id = $3")
            .bind(i.org()).bind(state).bind(run).execute(&i.owner).await.unwrap();
        let record = i.f.hr.import_run(i.f.principal.clone(), run).await.unwrap();
        assert_eq!(record.apply_job_state.as_deref(), Some(state));
        assert!(
            i.f.hr
                .import_runs(i.f.principal.clone(), RunListQuery::default())
                .await
                .unwrap()
                .items
                .is_empty()
        );
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn run_record_not_found_is_the_same_for_unknown_other_tenant_and_other_kind(pool: PgPool) {
    let i = importer(pool.clone()).await;
    let other = importer(pool).await;
    let run: Uuid = sqlx::query_scalar("INSERT INTO data_import_runs (org_id, entity_type, status, source_filename, source_format, source_sha256, pay_period_start, pay_period_end) VALUES ($1, 'attendance_direct', 'PREVIEWED', 'attendance.xlsx', 'xlsx', repeat('a', 64), '2026-10-01', '2026-10-31') RETURNING id")
        .bind(i.org()).fetch_one(&i.owner).await.unwrap();
    let sheet = table("명부", 0, &[&["사번", "성명"], &["RB-03", "다테스트"]]);
    let foreign = other
        .preview("foreign.xlsx", &[sheet], &WorkbookMappingRequest::default())
        .await
        .unwrap()
        .run_id;
    for id in [Uuid::new_v4(), run, foreign] {
        let refused =
            i.f.hr
                .import_run(i.f.principal.clone(), id)
                .await
                .unwrap_err();
        assert_eq!(
            (refused.status.as_u16(), refused.code),
            (404, "import_run_not_found")
        );
    }
    assert!(
        i.f.hr
            .import_runs(i.f.principal.clone(), RunListQuery::default())
            .await
            .unwrap()
            .items
            .is_empty()
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn run_reads_require_org_wide_employee_manage_even_with_a_valid_run_id(pool: PgPool) {
    let i = importer(pool).await;
    let denied = Principal::new(
        i.f.principal.user_id,
        i.f.principal.org_id,
        [Role::Member].into(),
        BranchScope::All,
    );
    let scoped = denied
        .clone()
        .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
            Feature::EmployeeDirectoryManage,
            PermissionLevel::Allow,
            BranchScope::Branches([console_kernel_core::BranchId::from_uuid(i.f.branch)].into()),
        )]);
    for principal in [denied, scoped] {
        assert_eq!(
            i.f.hr
                .import_runs(principal.clone(), RunListQuery::default())
                .await
                .unwrap_err()
                .status
                .as_u16(),
            403
        );
        assert_eq!(
            i.f.hr
                .import_run(principal.clone(), Uuid::new_v4())
                .await
                .unwrap_err()
                .status
                .as_u16(),
            403
        );
        assert_eq!(
            i.f.hr
                .preview_import_rollback(principal.clone(), Uuid::new_v4())
                .await
                .unwrap_err()
                .status
                .as_u16(),
            403
        );
        assert_eq!(
            i.f.hr
                .rollback_import(principal, Uuid::new_v4(), command("unused"), None, SOLO)
                .await
                .unwrap_err()
                .status
                .as_u16(),
            403
        );
    }
}

#[path = "rollback_1_journey.rs"]
mod rollback_1_journey;

#[path = "rollback_2_journey.rs"]
mod rollback_2_journey;

#[path = "rollback_3_journey.rs"]
mod rollback_3_journey;

#[path = "rollback_home_branch.rs"]
mod rollback_home_branch;
