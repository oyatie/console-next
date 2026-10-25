// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Completion consumes exactly the governed fact or waiver bound to its item.

#[allow(dead_code)]
#[path = "emp_create/fixture.rs"]
mod fixture;

use console_governance_adapter_postgres::exception::{
    AttestRequest, ExceptionRequest, attest_conn, request_exception_conn,
};
use console_governance_domain::exception::{
    Attestation, AttestationDetails, ExceptionSettings, RuleCode, SoleHolderMode, SubjectType,
};
use console_hr_adapter_postgres::{
    cases::{CaseItem, CompleteItem, LifecycleCase},
    clock::today_kst,
};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

fn settings() -> ExceptionSettings {
    ExceptionSettings {
        approval_ttl_days: 14,
        sole_holder_mode: SoleHolderMode::StepUpNoticeReview,
        sole_holder_review_due: std::time::Duration::from_secs(86_400 * 30),
    }
}

async fn hire(pool: PgPool) -> (fixture::Fixture, LifecycleCase) {
    let f = fixture::fixture(pool).await;
    let mut body = f.body("lifecycle-evidence", "REGULAR");
    body.hire_date = Some(today_kst().to_string());
    let employee = f.create(body).await.unwrap().employee_id();
    let case =
        f.hr.employee_lifecycle_cases(f.principal.clone(), employee)
            .await
            .unwrap()
            .remove(0);
    (f, case)
}

fn document(case: &LifecycleCase) -> &CaseItem {
    case.items.iter().find(|item| item.kind == "DOC").unwrap()
}

fn completion(item: &CaseItem, exception: Uuid, reason: Option<&str>) -> CompleteItem {
    serde_json::from_value(
        json!({"expected_version":item.version,"exception_id":exception,
        "waive":reason.is_some(),"reason":reason}),
    )
    .unwrap()
}

async fn org_tx(f: &fixture::Fixture) -> Transaction<'static, Postgres> {
    let mut tx = f.rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(f.principal.org_id.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx
}

async fn attested(f: &fixture::Fixture, subject: Uuid, fact: RuleCode) -> Uuid {
    let attestation = Attestation {
        fact,
        fact_date: today_kst(),
        details: AttestationDetails {
            evidence_ref: Some("governed-document-receipt".to_owned()),
            ..Default::default()
        },
    };
    let mut tx = org_tx(f).await;
    let fact = attest_conn(
        tx.as_mut(),
        &AttestRequest {
            attestation: &attestation,
            subject_type: SubjectType::LifecycleCaseItem,
            subject_id: subject,
            reason_code: "COMPLETED_OFFLINE",
            note: None,
            attested_by: f.principal.user_id,
            step_up_assertion_id: Some(Uuid::new_v4()),
        },
        &settings(),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    fact.exception_id
}

async fn waiver(f: &fixture::Fixture, item: &CaseItem, reason: &str, payload: Value) -> Uuid {
    let mut tx = org_tx(f).await;
    let exception = request_exception_conn(
        tx.as_mut(),
        &ExceptionRequest {
            rule: RuleCode::parse(item.waiver_rule_ref.as_deref().unwrap()).unwrap(),
            subject_type: SubjectType::LifecycleCaseItem,
            subject_id: item.id,
            reason_code: "LIFECYCLE_REVIEWED",
            note: Some(reason),
            payload: &payload,
            affected_periods: &[],
            requested_by: f.principal.user_id,
            step_up_assertion_id: Some(Uuid::new_v4()),
            other_eligible_holders: 0,
        },
        &settings(),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    exception.id
}

async fn consumed(pool: &PgPool, id: Uuid) -> bool {
    sqlx::query_scalar("SELECT consumed_at IS NOT NULL FROM governed_exceptions WHERE id=$1")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn governed_attestation_completes_the_item_and_consumes_its_exception(pool: PgPool) {
    let (f, case) = hire(pool.clone()).await;
    let item = document(&case);
    let rule = RuleCode::parse(item.completion_rule_ref.as_deref().unwrap()).unwrap();
    let exception = attested(&f, item.id, rule).await;
    let completed =
        f.hr.complete_lifecycle_item(
            f.principal.clone(),
            case.id,
            item.id,
            completion(item, exception, None),
        )
        .await
        .unwrap();
    let completed = completed
        .items
        .iter()
        .find(|done| done.id == item.id)
        .unwrap();
    assert_eq!(completed.status, "DONE_ATTESTED");
    assert_eq!(completed.exception_id, Some(exception));
    assert!(consumed(&pool, exception).await);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn governed_waiver_retains_the_reviewed_reason_and_consumes_its_exception(pool: PgPool) {
    let (f, case) = hire(pool.clone()).await;
    let item = document(&case);
    let reason = "담당자가 기존 서류를 확인하여 중복 확인을 면제함";
    let exception = waiver(&f, item, reason, json!({"item_id":item.id,"reason":reason})).await;
    let completed =
        f.hr.complete_lifecycle_item(
            f.principal.clone(),
            case.id,
            item.id,
            completion(item, exception, Some(reason)),
        )
        .await
        .unwrap();
    let completed = completed
        .items
        .iter()
        .find(|done| done.id == item.id)
        .unwrap();
    assert_eq!(completed.status, "WAIVED");
    assert_eq!(completed.exception_id, Some(exception));
    assert_eq!(completed.completion_reason.as_deref(), Some(reason));
    assert!(consumed(&pool, exception).await);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn another_subject_rule_or_payload_cannot_complete_the_item(pool: PgPool) {
    let (f, case) = hire(pool.clone()).await;
    let item = document(&case);
    let rule = RuleCode::parse(item.completion_rule_ref.as_deref().unwrap()).unwrap();
    let wrong_subject = attested(&f, Uuid::new_v4(), rule).await;
    let wrong_rule = attested(&f, item.id, RuleCode::ResignationReceived).await;
    let reason = "검토한 면제 사유";
    let wrong_payload = waiver(
        &f,
        item,
        reason,
        json!({"item_id":item.id,"reason":"승인되지 않은 다른 사유"}),
    )
    .await;
    for (exception, reason) in [
        (wrong_subject, None),
        (wrong_rule, None),
        (wrong_payload, Some(reason)),
    ] {
        let error =
            f.hr.complete_lifecycle_item(
                f.principal.clone(),
                case.id,
                item.id,
                completion(item, exception, reason),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "lifecycle.refuse.evidence_required");
        assert!(
            !consumed(&pool, exception).await,
            "a refusal cannot consume evidence"
        );
    }
    let unchanged =
        f.hr.lifecycle_case(f.principal.clone(), case.id)
            .await
            .unwrap();
    assert_eq!(document(&unchanged).status, "OPEN");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn superseded_filing_receipt_cannot_be_reused_as_observed_evidence(pool: PgPool) {
    let (f, case) = hire(pool.clone()).await;
    let item = case
        .items
        .iter()
        .find(|item| item.kind == "FIL" && item.insurer.as_deref() == Some("NHIS"))
        .unwrap();
    let old_receipt: Uuid = sqlx::query_scalar("INSERT INTO insurance_filing_records \
        (org_id,event_id,filing_kind,insurer,version,action,completed_on,receipt_number,actor,idempotency_key,request_hash) \
        VALUES ($1,$2,'ACQUIRE','NHIS',1,'COMPLETE',$3,'old-receipt',$4,'old-complete',repeat('a',64)) RETURNING id")
        .bind(f.principal.org_id.as_uuid()).bind(case.trigger_id.unwrap()).bind(today_kst())
        .bind(f.principal.user_id.as_uuid()).fetch_one(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO insurance_filing_records \
        (org_id,event_id,filing_kind,insurer,version,action,actor,idempotency_key,request_hash) \
        VALUES ($1,$2,'ACQUIRE','NHIS',2,'UNDO',$3,'old-undo',repeat('b',64))",
    )
    .bind(f.principal.org_id.as_uuid())
    .bind(case.trigger_id.unwrap())
    .bind(f.principal.user_id.as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    let error =
        f.hr.complete_lifecycle_item(
            f.principal.clone(),
            case.id,
            item.id,
            serde_json::from_value(json!({"expected_version":item.version,
            "observed_ref":{"table":"insurance_filing_records","id":old_receipt}}))
            .unwrap(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "lifecycle.refuse.evidence_required");
}
