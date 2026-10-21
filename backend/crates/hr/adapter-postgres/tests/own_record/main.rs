#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! people-self-33 (r2, P0): an HR worker holding 인사 실무 over the 법인
//! reported (201) and HR-confirmed (200) their OWN exit. The `own_record`
//! Cedar action now refuses every HR write whose subject is the actor's own
//! record (403 `own_record_forbidden`, nothing written); the ops account
//! passes only as the sole holder, audited for review. Red on bec13989.

#[path = "../support/go_live.rs"]
mod go_live;
mod world;
mod writes;

use console_hr_adapter_postgres::corrections::{CorrectEmployeeRequest, SecondPersonContext};
use console_hr_adapter_postgres::exits::types::ReportEmployeeExitCaseRequest;
use console_hr_adapter_postgres::lifecycle::requests::CreateEmployeeLifecycleEventRequest;
use console_platform_test_support::soft_passkey::passkey_service;
use serde_json::json;
use sqlx::PgPool;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use world::{OWN, close, confirm, refused, world};

/// regression: people-self-33 — report, HR confirm, cancel, reject and a
/// lifecycle event on one's own record are refused and write nothing.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_hr_worker_cannot_record_their_own_exit(pool: PgPool) {
    let w = world(pool).await;
    let (worker, own) = w.hr_worker().await;
    let other = w.employee("김직원").await;

    let (status, code, refusals) = refused(w.report(&worker, own).await);
    assert_eq!((status, code), OWN);
    assert_eq!(refusals[0]["remedy"], "another_holder_or_ops");
    let cases = "SELECT count(*) FROM employee_exit_cases WHERE employee_id = $1";
    assert_eq!(w.count(cases, own).await, 0, "no case written");
    let claims =
        "SELECT count(*) FROM api_idempotency_keys WHERE idempotency_key = 'own-' || $1::text";
    assert_eq!(w.count(claims, own).await, 0, "no idempotency claim");
    // The record's end offers say so, so no verb is drawn on it.
    let ends = w.hr.employee_end_options(&worker, own).await.unwrap();
    assert_eq!(ends.exit.refusal, Some("own_record_forbidden"));
    assert_eq!(ends.cancel.refusal, Some("own_record_forbidden"));
    let detail = w.hr.employee_detail(worker.clone(), own).await.unwrap();
    assert!(
        detail.allowed_events.is_empty(),
        "no 발령 offered on one's own record"
    );
    // Someone else's record is the worker's ordinary work.
    let detail = w.hr.employee_detail(worker.clone(), other).await.unwrap();
    assert!(!detail.allowed_events.is_empty());
    assert!(
        w.hr.employee_end_options(&worker, other)
            .await
            .unwrap()
            .exit
            .allowed
    );
    w.report(&worker, other).await.unwrap();

    // The ops account reports it; the worker still cannot confirm or close it.
    let case = w.report(&w.ops, own).await.unwrap();
    let confirm =
        w.hr.confirm_exit_case(worker.clone(), None, case, confirm())
            .await;
    let (status, code, _) = refused(confirm);
    assert_eq!((status, code), OWN);
    let status_sql =
        "SELECT count(*) FROM employee_exit_cases WHERE id = $1 AND status = 'REPORTED'";
    assert_eq!(w.count(status_sql, case).await, 1, "still REPORTED");
    let terminate = "SELECT count(*) FROM employee_lifecycle_events WHERE employee_id = $1 \
                     AND event_type = 'TERMINATE'";
    assert_eq!(w.count(terminate, own).await, 0, "no TERMINATE recorded");
    for to in ["REJECTED", "CANCELLED"] {
        let (status, code, _) = refused(
            w.hr.close_exit_case(worker.clone(), case, close(), to)
                .await,
        );
        assert_eq!((status, code), OWN, "{to}");
    }
    assert_eq!(w.count(status_sql, case).await, 1, "still REPORTED");

    let promote: CreateEmployeeLifecycleEventRequest = serde_json::from_value(json!({
        "event_type": "PROMOTE", "to_position": "주임",
        "effective_date": console_hr_adapter_postgres::clock::today_kst().to_string(),
        "comment": "self", "signoffs": {"privacy_notice_ack": true, "korean_labor_law_ack": true},
    }))
    .unwrap();
    let recorded =
        w.hr.record_lifecycle_event(worker.clone(), own, Uuid::new_v4().to_string(), promote)
            .await;
    let (status, code, _) = refused(recorded);
    assert_eq!((status, code), OWN);
    let events = "SELECT count(*) FROM employee_lifecycle_events WHERE employee_id = $1";
    assert_eq!(w.count(events, own).await, 0, "no lifecycle event");
}

/// regression: people-self-33 — 정보 정정 of one's own record is refused.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_hr_worker_cannot_correct_their_own_record(pool: PgPool) {
    let w = world(pool).await;
    let (worker, own) = w.hr_worker().await;
    let at: OffsetDateTime = sqlx::query_scalar("SELECT updated_at FROM employees WHERE id = $1")
        .bind(own)
        .fetch_one(&w.owner)
        .await
        .unwrap();
    let body: CorrectEmployeeRequest = serde_json::from_value(json!({
        "expected_updated_at": at.format(&Rfc3339).unwrap(),
        "changes": { "job": "총무" }, "reason_code": "DATA_ENTRY_ERROR",
    }))
    .unwrap();
    let holders = SecondPersonContext {
        other_eligible_holders: 1,
        sole_holder_refuse: false,
        routed: true,
    };
    let result =
        w.hr.correct_employee(worker, &passkey_service(), own, body, holders)
            .await;
    let (status, code, _) = refused(result);
    assert_eq!((status, code), OWN);
    let job: String = sqlx::query_scalar("SELECT job FROM employees WHERE id = $1")
        .bind(own)
        .fetch_one(&w.owner)
        .await
        .unwrap();
    assert_eq!(job, "인사", "nothing corrected");
}

/// The ops account linked to its own record (a solo admin): it records its
/// own exit only while no other account holds 퇴직 등록, and that pass is
/// audited for review. Once someone else holds it, ops is refused too.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ops_records_its_own_exit_only_as_the_sole_holder(pool: PgPool) {
    let w = world(pool).await;
    let own = w.employee("나관리").await;
    w.link(*w.ops.user_id.as_uuid(), own).await;

    let ends = w.hr.employee_end_options(&w.ops, own).await.unwrap();
    assert!(ends.exit.allowed, "the sole holder is offered its own exit");
    let case = w.report(&w.ops, own).await.unwrap();
    let audit = "SELECT count(*) FROM audit_events WHERE action = 'authz.own_record.break_glass' \
                 AND target_id = $1::text AND (after_snap->>'review_required')::bool";
    assert_eq!(
        w.count(audit, own).await,
        1,
        "break-glass audited for review"
    );
    w.hr.close_exit_case(w.ops.clone(), case, close(), "CANCELLED")
        .await
        .unwrap();

    let (_, colleague_employee) = w.hr_worker().await;
    let colleague: Uuid = sqlx::query_scalar("SELECT id FROM users WHERE employee_id = $1")
        .bind(colleague_employee)
        .fetch_one(&w.owner)
        .await
        .unwrap();
    w.grant_exit_role(colleague).await;
    let body: ReportEmployeeExitCaseRequest = serde_json::from_value(json!({
        "employee_id": own, "effective_exit_date": "2026-12-31", "site_manager_note": "사직",
    }))
    .unwrap();
    let again =
        w.hr.report_exit_case(w.ops.clone(), Uuid::new_v4().to_string(), body)
            .await;
    let (status, code, _) = refused(again);
    assert_eq!((status, code), OWN, "another holder records it");
    let open = "SELECT count(*) FROM employee_exit_cases WHERE employee_id = $1 \
                AND status NOT IN ('CANCELLED', 'REJECTED')";
    assert_eq!(w.count(open, own).await, 0, "nothing reported");
}
