//! 이관 확인 (BE-EMP-UI; spec E7-reconcile, E7-row, E7-signoff): the server's
//! funnel, 배치 대조, per-row state and the one HR sign-off of an applied run.

use console_hr_adapter_postgres::HrError;
use console_hr_adapter_postgres::import::reconcile::ReconcileRowsQuery;
use console_hr_adapter_postgres::import::reconcile_write::{
    SetReconcileCheckRequest, SignOffImportRequest,
};
use console_hr_domain::import::detect::WorkbookMappingRequest;
use console_kernel_core::{BranchScope, UserId};
use console_platform_authz::{EffectiveFeatureGrant, Feature, PermissionLevel, Principal, Role};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::harness::{Importer, decisions, importer, table};

fn sheets() -> Vec<console_hr_domain::import::grid::GridSheet> {
    let header: &[&str] = &["사번", "성명", "주민등록번호", "입사일", "재직상태"];
    vec![table(
        "명부",
        0,
        &[
            header,
            &["2001", "강가", "900101-1234567", "2024-03-04", "재직"],
            &["2002", "남나", "", "2023-01-02", "재직"],
            &["2003", "도다", "", "2025-02-03", "재직"],
        ],
    )]
}

/// Previewed and dry-run, not applied: (run, digest).
async fn planned(i: &Importer) -> (Uuid, String) {
    let run = i
        .preview("people.xlsx", &sheets(), &WorkbookMappingRequest::default())
        .await
        .unwrap()
        .run_id;
    let plan = i.dry_run(run, decisions()).await;
    (run, plan.dry_run_digest)
}

fn check(state: &str, version: Option<i32>) -> SetReconcileCheckRequest {
    // Built directly: the wire validator refuses an unknown state before the domain, and the
    // `DONE` case exercises the domain's own refusal.
    SetReconcileCheckRequest {
        state: state.to_owned(),
        note: None,
        expected_version: version,
    }
}

fn sign(open: i64, ack: bool) -> SignOffImportRequest {
    serde_json::from_value(json!({"expected_open_count": open, "acknowledge_open": ack})).unwrap()
}

fn code(e: &HrError) -> (u16, &'static str) {
    (e.status.as_u16(), e.code)
}

async fn audits(i: &Importer, action: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id = $1 AND action = $2")
        .bind(i.org())
        .bind(action)
        .fetch_one(&i.owner)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn reconcile_waits_for_the_apply(pool: PgPool) {
    let i = importer(pool).await;
    let (run, _) = planned(&i).await;
    let p = || i.f.principal.clone();
    let before = i.f.hr.import_reconcile(p(), run).await.unwrap_err();
    assert_eq!(code(&before), (409, "import_not_applied"));
    let row =
        i.f.hr
            .set_import_reconcile_check(p(), run, "x".into(), check("CONFIRMED", None))
            .await
            .unwrap_err();
    assert_eq!(code(&row), (409, "import_not_applied"));
    let signed =
        i.f.hr
            .sign_off_import(p(), run, sign(0, true))
            .await
            .unwrap_err();
    assert_eq!(code(&signed), (409, "import_not_applied"));
    let unknown =
        i.f.hr
            .import_reconcile(p(), Uuid::new_v4())
            .await
            .unwrap_err();
    assert_eq!(code(&unknown).0, 404);
    assert_eq!(
        i.count("SELECT count(*) FROM import_reconcile_checks WHERE org_id = $1")
            .await,
        0
    );
    assert_eq!(audits(&i, "data_import.reconcile_check").await, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_applied_run_is_reconciled_checked_and_signed_off_once(pool: PgPool) {
    let i = importer(pool).await;
    let (run, digest) = planned(&i).await;
    i.apply(run, &digest).await.unwrap();
    // One person the file did not name.
    sqlx::query(
        "INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, \
         source_key, hire_date) VALUES ($1, 'Co', '라라', 'console', 'console', 1, $2, '2024-01-01')",
    )
    .bind(i.org())
    .bind(Uuid::new_v4().to_string())
    .execute(&i.owner)
    .await
    .unwrap();
    let p = || i.f.principal.clone();
    let rec = i.f.hr.import_reconcile(p(), run).await.unwrap();
    let rec = serde_json::to_value(&rec).unwrap();
    assert_eq!(rec["funnels"][0]["sheet"], "명부");
    assert_eq!(
        (
            rec["funnels"][0]["read"].clone(),
            rec["funnels"][0]["inserted"].clone()
        ),
        (json!(3), json!(3))
    );
    let total: i64 = rec["placement"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["now"].as_i64().unwrap())
        .sum();
    let from_file: i64 = rec["placement"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["from_file"].as_i64().unwrap())
        .sum();
    assert_eq!((from_file, total), (3, 4));
    assert_eq!(
        rec["counts"],
        json!({"rows": 3, "confirmed": 0, "needs_check": 0, "unchecked": 3})
    );
    assert!(rec["signoff"].is_null());
    // Rows: name and 사번 only, never the 주민등록번호.
    let rows =
        i.f.hr
            .import_reconcile_rows(p(), run, ReconcileRowsQuery::default())
            .await
            .unwrap();
    assert!(!serde_json::to_string(&rows).unwrap().contains("234567"));
    let key = rows.items[0].source_key.clone();
    assert_eq!(
        (rows.items[0].state.as_str(), rows.items[0].version),
        ("UNCHECKED", 0)
    );
    let done =
        i.f.hr
            .set_import_reconcile_check(p(), run, key.clone(), check("CONFIRMED", Some(0)))
            .await
            .unwrap();
    assert_eq!((done.state.as_str(), done.version), ("CONFIRMED", 1));
    // A stale write is refused and changes nothing.
    let stale =
        i.f.hr
            .set_import_reconcile_check(p(), run, key.clone(), check("NEEDS_CHECK", Some(0)))
            .await
            .unwrap_err();
    assert_eq!(code(&stale), (409, "stale_revision"));
    assert_eq!(stale.refusals.unwrap()[0]["current_version"], 1);
    for (bad, want) in [
        (check("DONE", None), 422),
        (
            serde_json::from_value(json!({"state": "CONFIRMED", "note": "가".repeat(1001)}))
                .unwrap(),
            422,
        ),
    ] {
        let e =
            i.f.hr
                .set_import_reconcile_check(p(), run, key.clone(), bad)
                .await
                .unwrap_err();
        assert_eq!(code(&e).0, want);
    }
    let missing =
        i.f.hr
            .set_import_reconcile_check(p(), run, "nope".into(), check("CONFIRMED", None))
            .await
            .unwrap_err();
    assert_eq!(code(&missing).0, 404);
    assert_eq!(audits(&i, "data_import.reconcile_check").await, 1);
    // Paging and the state filter.
    let page: ReconcileRowsQuery = serde_json::from_value(json!({"limit": 2})).unwrap();
    let first = i.f.hr.import_reconcile_rows(p(), run, page).await.unwrap();
    assert_eq!(first.items.len(), 2);
    let next: ReconcileRowsQuery =
        serde_json::from_value(json!({"limit": 2, "after": first.next_cursor})).unwrap();
    assert_eq!(
        i.f.hr
            .import_reconcile_rows(p(), run, next)
            .await
            .unwrap()
            .items
            .len(),
        1
    );
    let confirmed: ReconcileRowsQuery =
        serde_json::from_value(json!({"state": "confirmed"})).unwrap();
    assert_eq!(
        i.f.hr
            .import_reconcile_rows(p(), run, confirmed)
            .await
            .unwrap()
            .items
            .len(),
        1
    );
    // Sign-off: the open count must match, an open count must be said.
    let moved =
        i.f.hr
            .sign_off_import(p(), run, sign(1, true))
            .await
            .unwrap_err();
    assert_eq!(code(&moved), (409, "import_reconcile_changed"));
    let unsaid =
        i.f.hr
            .sign_off_import(p(), run, sign(2, false))
            .await
            .unwrap_err();
    assert_eq!(code(&unsaid), (428, "import_signoff_ack_required"));
    assert_eq!(
        i.count("SELECT count(*) FROM import_signoffs WHERE org_id = $1")
            .await,
        0
    );
    assert_eq!(audits(&i, "data_import.signoff").await, 0);
    let signed =
        i.f.hr
            .sign_off_import(p(), run, sign(2, true))
            .await
            .unwrap();
    assert_eq!(
        (signed.total_rows, signed.confirmed, signed.unchecked),
        (3, 1, 2)
    );
    // Once: a second sign-off and any later row write are refused.
    let twice =
        i.f.hr
            .sign_off_import(p(), run, sign(2, true))
            .await
            .unwrap_err();
    assert_eq!(code(&twice), (409, "import_signed_off"));
    let frozen =
        i.f.hr
            .set_import_reconcile_check(p(), run, key, check("NEEDS_CHECK", Some(1)))
            .await
            .unwrap_err();
    assert_eq!(code(&frozen), (409, "import_signed_off"));
    assert_eq!(audits(&i, "data_import.signoff").await, 1);
    assert_eq!(audits(&i, "data_import.reconcile_check").await, 1);
    let after: Value =
        serde_json::to_value(i.f.hr.import_reconcile(p(), run).await.unwrap()).unwrap();
    assert_eq!(after["signoff"]["confirmed"], 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn reconcile_is_the_imports_gate(pool: PgPool) {
    let i = importer(pool).await;
    let (run, digest) = planned(&i).await;
    i.apply(run, &digest).await.unwrap();
    let reader = Principal::new(
        UserId::from_uuid(*i.f.principal.user_id.as_uuid()),
        i.f.principal.org_id,
        [Role::Member].into_iter().collect(),
        BranchScope::All,
    )
    .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
        Feature::EmployeeDirectoryRead,
        PermissionLevel::Allow,
        BranchScope::All,
    )]);
    let r = || reader.clone();
    assert_eq!(
        code(&i.f.hr.import_reconcile(r(), run).await.unwrap_err()),
        (403, "forbidden")
    );
    let rows =
        i.f.hr
            .import_reconcile_rows(r(), run, ReconcileRowsQuery::default())
            .await
            .unwrap_err();
    assert_eq!(code(&rows), (403, "forbidden"));
    let write =
        i.f.hr
            .set_import_reconcile_check(r(), run, "x".into(), check("CONFIRMED", None))
            .await
            .unwrap_err();
    assert_eq!(code(&write), (403, "forbidden"));
    let signed =
        i.f.hr
            .sign_off_import(r(), run, sign(3, true))
            .await
            .unwrap_err();
    assert_eq!(code(&signed), (403, "forbidden"));
    assert_eq!(
        i.count("SELECT count(*) FROM import_signoffs WHERE org_id = $1")
            .await,
        0
    );
}
