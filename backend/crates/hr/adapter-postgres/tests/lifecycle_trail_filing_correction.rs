// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Undo retains the old proof and opens blocking work until its replacement is filed.

#[allow(dead_code)]
#[path = "emp_create/fixture.rs"]
mod fixture;

use console_compliance_adapter_postgres::PgComplianceStore;
use console_hr_adapter_postgres::{clock::today_kst, statutory::RecordFiling};
use serde_json::json;
use sqlx::PgPool;

fn complete(version: i64, receipt: &str) -> RecordFiling {
    serde_json::from_value(json!({"expected_version":version,"action":"COMPLETE",
        "completed_on":today_kst().to_string(),"receipt_number":receipt,
        "applicability_facts":{"monthly_hours":160,"weekly_hours":40,"continuous_months":1,
            "daily":false,"foreign":false,"director_without_worker_status":false}}))
    .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn undo_reopens_the_case_and_refiling_resolves_only_the_correction(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let mut body = f.body("filing-correction-hire", "REGULAR");
    body.hire_date = Some(today_kst().to_string());
    let employee = f.create(body).await.unwrap().employee_id();
    let case =
        f.hr.employee_lifecycle_cases(f.principal.clone(), employee)
            .await
            .unwrap()
            .remove(0);
    let original = case
        .items
        .iter()
        .find(|item| item.insurer.as_deref() == Some("NHIS") && item.kind == "FIL")
        .unwrap();
    let event = case.trigger_id.unwrap();
    let target = || (event, "ACQUIRE".to_owned(), "NHIS".to_owned());
    let register = PgComplianceStore::new(pool.clone())
        .statutory_register()
        .await
        .unwrap();
    f.hr.record_insurance_filing(
        f.principal.clone(),
        target(),
        "correction-first".into(),
        complete(0, "first-proof"),
        register.clone(),
    )
    .await
    .unwrap();
    let before =
        f.hr.lifecycle_case(f.principal.clone(), case.id)
            .await
            .unwrap();
    let before = before
        .items
        .iter()
        .find(|item| item.id == original.id)
        .unwrap();
    assert_eq!(before.status, "DONE_OBSERVED");
    let old_proof = before.observed_ref.clone();
    // Other work is outside this filing correction scenario; leave terminal evidence untouched.
    sqlx::query(
        "UPDATE lifecycle_case_items SET blocks_close=false WHERE org_id=$1 AND case_id=$2 \
        AND id<>$3 AND status IN ('OPEN','PENDING_TRIGGER','BLOCKED')",
    )
    .bind(f.principal.org_id.as_uuid())
    .bind(case.id)
    .bind(original.id)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        f.hr.close_lifecycle_case(f.principal.clone(), case.id)
            .await
            .unwrap()
            .state,
        "CLOSED"
    );

    let undo = serde_json::from_value(json!({"expected_version":1,"action":"UNDO"})).unwrap();
    f.hr.record_insurance_filing(
        f.principal.clone(),
        target(),
        "correction-undo".into(),
        undo,
        register.clone(),
    )
    .await
    .unwrap();
    let reopened =
        f.hr.lifecycle_case(f.principal.clone(), case.id)
            .await
            .unwrap();
    assert_eq!(reopened.state, "OPEN");
    let kept = reopened
        .items
        .iter()
        .find(|item| item.id == original.id)
        .unwrap();
    assert_eq!(kept.status, "CORRECTION_NEEDED");
    assert_eq!(kept.observed_ref, old_proof);
    let corrections: Vec<_> = reopened
        .items
        .iter()
        .filter(|item| {
            item.item_key.starts_with("AH")
                && item.filing_obligation_id == original.filing_obligation_id
        })
        .collect();
    assert_eq!(corrections.len(), 1);
    let correction = corrections[0];
    assert_eq!(correction.status, "OPEN");
    assert!(correction.blocks_close);
    let error =
        f.hr.close_lifecycle_case(f.principal.clone(), case.id)
            .await
            .unwrap_err();
    assert_eq!(error.code, "lifecycle.refuse.close_blocked");

    f.hr.record_insurance_filing(
        f.principal.clone(),
        target(),
        "correction-refile".into(),
        complete(2, "replacement-proof"),
        register,
    )
    .await
    .unwrap();
    let repaired =
        f.hr.lifecycle_case(f.principal.clone(), case.id)
            .await
            .unwrap();
    let replacement = repaired
        .items
        .iter()
        .find(|item| item.id == correction.id)
        .unwrap();
    assert_eq!(replacement.status, "DONE_OBSERVED");
    assert_ne!(replacement.observed_ref, old_proof);
    assert_eq!(
        repaired
            .items
            .iter()
            .find(|item| item.id == original.id)
            .unwrap()
            .observed_ref,
        old_proof
    );
    assert_eq!(
        f.hr.close_lifecycle_case(f.principal.clone(), case.id)
            .await
            .unwrap()
            .state,
        "CLOSED"
    );
}
