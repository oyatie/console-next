#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use super::super::{read, tests::Fixture};
use axum::{body::to_bytes, response::IntoResponse};
use console_compliance_adapter_postgres::PgComplianceStore;
use console_hr_adapter_postgres::{HrService, statutory::FilingQuery};
use console_kernel_core::{
    AuditAction, AuditCommandContext, AuditEvent, BranchId, BranchScope, TraceContext,
};
use console_platform_authz::{EffectiveFeatureGrant, Feature, PermissionLevel, Role};
use console_platform_db::{DbError, command_context, command_outcomes, with_audit};
use console_platform_test_support::MIGRATOR;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::BTreeSet;
use uuid::Uuid;

async fn filing(f: &Fixture) -> (Uuid, Uuid, BranchId, Value) {
    let branch = BranchId::new();
    let region = Uuid::new_v4();
    sqlx::query("INSERT INTO regions (org_id,id,name) VALUES ($1,$2,'filing')")
        .bind(f.submitter.org_id.as_uuid())
        .bind(region)
        .execute(&f.owner)
        .await
        .unwrap(); // rls-arming: ok owner fixture
    sqlx::query("INSERT INTO branches (org_id,id,region_id,name) VALUES ($1,$2,$3,'filing')")
        .bind(f.submitter.org_id.as_uuid())
        .bind(branch.as_uuid())
        .bind(region)
        .execute(&f.owner)
        .await
        .unwrap(); // rls-arming: ok owner fixture
    let employee = Uuid::new_v4();
    let mut tx = f.owner.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE console_leave_cmd")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SELECT * FROM leave_api.create_employee($1,$2,$3,'employee','company','REGULAR','+821012345678','Operations','Member','Seoul',$4,0::numeric,$5,$6,$7,$8,$9)")
        .bind(f.submitter.org_id.as_uuid()).bind(employee).bind(format!("FILING-{employee}"))
        .bind(branch.as_uuid()).bind(format!("filing-{employee}")).bind("a".repeat(64))
        .bind(f.submitter.user_id.as_uuid()).bind("0123456789abcdef0123456789abcdef").bind("0123456789abcdef")
        .fetch_one(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    let event = Uuid::new_v4();
    sqlx::query("INSERT INTO employee_lifecycle_events (org_id,id,employee_id,event_type,to_status,effective_date,comment,created_by,state) VALUES ($1,$2,$3,'ONBOARD','ACTIVE','2026-09-01','hire',$4,'APPLIED')")
        .bind(f.submitter.org_id.as_uuid()).bind(event).bind(employee).bind(f.submitter.user_id.as_uuid())
        .execute(&f.owner).await.unwrap(); // rls-arming: ok owner fixture
    let register = PgComplianceStore::new(f.rt.clone())
        .statutory_register()
        .await
        .unwrap();
    let page = HrService::new(f.rt.clone())
        .insurance_filings(
            f.submitter.clone(),
            FilingQuery {
                event_id: Some(event),
                ..FilingQuery::default()
            },
            register,
        )
        .await
        .unwrap();
    assert_eq!(page.total, 4);
    (event, employee, branch, serde_json::to_value(page).unwrap())
}

async fn saved(f: &Fixture, event: Uuid, result: Value, key: &str) -> Uuid {
    let reservation = command_outcomes::reserve(
        &f.rt,
        f.submitter.org_id,
        f.submitter.user_id,
        key.into(),
        "POST /api/v1/statutory/insurance-filings".into(),
        b"filing".to_vec(),
        json!({"fields":["anchor_on"]}),
    )
    .await
    .unwrap();
    let command_outcomes::Reservation::Fresh(id) = reservation else {
        panic!("new command")
    };
    let mut context = AuditCommandContext::for_actor(Some(f.submitter.user_id));
    context.command_id = Some(id);
    context.org_id = Some(f.submitter.org_id);
    let audit = AuditEvent::new(
        Some(f.submitter.user_id),
        AuditAction::new("insurance_filing.requested").unwrap(),
        "insurance_filing",
        event.to_string(),
        TraceContext::generate(),
        time::OffsetDateTime::now_utc(),
    )
    .with_org(f.submitter.org_id);
    command_context::scope(
        context,
        with_audit::<_, _, DbError>(&f.rt, audit, move |tx| {
            Box::pin(async move { command_outcomes::set_result(tx, &result).await })
        }),
    )
    .await
    .unwrap();
    id
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn filing_receipt_recovers_pages_and_single_tasks_without_losing_current_authority(
    pool: PgPool,
) {
    let f = Fixture::new(pool.clone()).await;
    let foreign = Fixture::new(pool).await;
    let (event, _, _, page) = filing(&f).await;
    for (key, result) in [
        ("requests-filing-page", page.clone()),
        ("requests-filing-single", page["items"][0].clone()),
    ] {
        let id = saved(&f, event, result.clone(), key).await;
        let visible = read(f.rt.clone(), f.submitter.clone(), key.into())
            .await
            .unwrap()
            .0;
        assert_eq!(visible["masked"], false);
        assert_eq!(visible["state"], "APPLIED");
        assert_eq!(visible["result"], result);
        let mut lost = f.submitter.clone();
        lost.roles = BTreeSet::from([Role::Member]);
        lost.effective_feature_grants = vec![EffectiveFeatureGrant::new(
            Feature::EmployeeDirectoryRead,
            PermissionLevel::Allow,
            BranchScope::All,
        )];
        let masked = read(f.rt.clone(), lost, id.to_string()).await.unwrap().0;
        assert_eq!(masked["masked"], true);
        assert!(masked["result"].is_null());
        assert_eq!(masked["touched"], json!([]));
        let denied = read(f.rt.clone(), foreign.submitter.clone(), id.to_string())
            .await
            .unwrap_err();
        let denied = denied.into_response();
        assert_eq!(denied.status(), http::StatusCode::NOT_FOUND);
        let body: Value =
            serde_json::from_slice(&to_bytes(denied.into_body(), 1024 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(body["error"]["code"], "request_not_found");
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn filing_receipt_masks_sensitive_facts_and_rechecks_scoped_employer_reads(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let (event, employee, branch, mut page) = filing(&f).await;
    for task in page["items"].as_array_mut().unwrap() {
        task["applicability_facts"]["birth_date"] = json!("1990-01-01");
        task["applicability_facts"]["monthly_income_won"] = json!(1234567);
    }
    let id = saved(&f, event, page.clone(), "requests-filing-scoped").await;
    let mut scoped = f.submitter.clone();
    scoped.roles = BTreeSet::from([Role::Member]);
    scoped.branch_scope = BranchScope::Branches(BTreeSet::from([branch]));
    scoped.effective_feature_grants = vec![EffectiveFeatureGrant::new(
        Feature::EmployeeDirectoryManage,
        PermissionLevel::Allow,
        scoped.branch_scope.clone(),
    )];
    let visible = read(f.rt.clone(), scoped.clone(), id.to_string())
        .await
        .unwrap()
        .0;
    assert_eq!(visible["masked"], false);
    for task in visible["result"]["items"].as_array().unwrap() {
        assert_eq!(task["can_record_sensitive_facts"], false);
        assert!(task["applicability_facts"]["birth_date"].is_null());
        assert!(task["applicability_facts"]["monthly_income_won"].is_null());
    }
    let mut tx = f.owner.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE employees SET home_branch_id=NULL WHERE org_id=$1 AND id=$2")
        .bind(f.submitter.org_id.as_uuid())
        .bind(employee)
        .execute(tx.as_mut())
        .await
        .unwrap(); // rls-arming: ok owner fixture
    tx.commit().await.unwrap();
    let masked = read(f.rt.clone(), scoped, id.to_string()).await.unwrap().0;
    assert_eq!(masked["masked"], true);
    assert!(masked["result"].is_null());
    let original: Value = sqlx::query_scalar("SELECT result FROM command_outcomes WHERE id=$1")
        .bind(id)
        .fetch_one(&f.owner)
        .await
        .unwrap(); // rls-arming: ok owner fixture
    assert_eq!(original, page);
}
