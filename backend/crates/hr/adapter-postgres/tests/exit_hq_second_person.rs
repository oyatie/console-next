#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Decisions #26 item d on the exit HQ tier, as `console_rt` against a live
//! tenant: under `approval.policy.exit = none` (the default) the HR confirmer
//! finishes the tier; under `route` a second person is required, and the
//! tenant ops account may be that person only after a passkey step-up bound
//! to the case. Every refusal leaves the case and the audit trail untouched.

mod support;

use console_hr_adapter_postgres::exits::confirm::exit_hq_binding;
use console_hr_adapter_postgres::exits::types::{
    ConfirmEmployeeExitCaseRequest, ReportEmployeeExitCaseRequest,
};
use console_platform_auth::MobilePasskeyStepUpEnvelope;
use console_platform_authz::Principal;
use console_platform_test_support::soft_passkey::passkey_service;
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use support::passkey::{enroll, step_up};
use support::{World, world};

async fn live(pool: &PgPool, w: &World, routed: bool) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(w.org.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    // rls-arming: ok test fixture moves the tenant past 운영 시작 as owner
    sqlx::query("UPDATE tenant_phase SET phase = 'OPERATING'")
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    sqlx::query("UPDATE users SET is_tenant_ops = true WHERE id = $1")
        .bind(w.hr_one)
        .execute(pool)
        .await
        .unwrap();
    if routed {
        // In force a day before the test's reads, so a step back of the test VM's
        // clock never puts `now()` before it (seen: routed read as none mid-test).
        // The insert trigger refuses backdating; the fixture skips it as owner.
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("SET LOCAL session_replication_role = replica")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO tenant_setting_overrides \
             (org_id, key, value, set_by, reason_code, effective_from) \
             VALUES ($1, 'approval.policy.exit', '\"route\"', $2, 'D26', now() - interval '1 day')",
        )
        .bind(w.org)
        .bind(w.hr_two)
        .execute(&mut *tx)
        .await
        .unwrap();
        tx.commit().await.unwrap();
    }
}

fn ops(w: &World) -> Principal {
    w.hr(w.hr_one).with_tenant_ops(true)
}

fn hq(step_up: Option<MobilePasskeyStepUpEnvelope>) -> ConfirmEmployeeExitCaseRequest {
    let mut body: ConfirmEmployeeExitCaseRequest =
        serde_json::from_value(json!({ "hq_confirmation": true })).unwrap();
    body.step_up = step_up;
    body
}

/// A case for `employee`, HR-confirmed by `hr_one`.
async fn hr_confirmed(w: &World, employee: Uuid) -> Uuid {
    let (_, report) =
        w.hr.report_exit_case(
            w.hr(w.hr_one),
            Uuid::new_v4().to_string(),
            ReportEmployeeExitCaseRequest {
                employee_id: employee,
                branch_id: None,
                absence_alert_id: None,
                effective_exit_date: "2026-06-30".into(),
                site_manager_note: "퇴직 의사 확인".into(),
                exit_reason_code: Some("PERSONAL".into()),
            },
        )
        .await
        .unwrap();
    let case: Uuid = report["id"].as_str().unwrap().parse().unwrap();
    let signoffs = json!({ "signoffs": {
        "privacy_notice_ack": true, "korean_labor_law_ack": true,
        "payroll_cutoff_ack": true, "retirement_settlement_ack": true,
    } });
    let confirmed =
        w.hr.confirm_exit_case(
            ops(w),
            None,
            case,
            serde_json::from_value(signoffs).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(confirmed.status, "HR_CONFIRMED");
    case
}

/// The case's status and HQ confirmer, and its `employee.exit.confirm` audit snapshots.
async fn state(pool: &PgPool, case: Uuid) -> (String, Option<Uuid>, Vec<Value>) {
    let (status, hq_by): (String, Option<Uuid>) =
        sqlx::query_as("SELECT status, hq_confirmed_by FROM employee_exit_cases WHERE id = $1")
            .bind(case)
            .fetch_one(pool)
            .await
            .unwrap();
    let audits: Vec<Value> = sqlx::query_scalar(
        "SELECT after_snap FROM audit_events WHERE action = 'employee.exit.confirm' \
         AND after_snap->>'exit_case_id' = $1 ORDER BY occurred_at",
    )
    .bind(case.to_string())
    .fetch_all(pool)
    .await
    .unwrap();
    (status, hq_by, audits)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn under_none_the_hr_confirmer_finishes_the_hq_tier_with_an_audit_row(pool: PgPool) {
    let w = world(&pool).await;
    live(&pool, &w, false).await;
    let case = hr_confirmed(&w, w.in_a).await;
    // No step-up asked for: nobody else is needed under none (non-ops too).
    let done =
        w.hr.confirm_exit_case(w.hr(w.hr_one), None, case, hq(None))
            .await
            .unwrap();
    assert_eq!(done.status, "HQ_CONFIRMED");
    let (_, hq_by, audits) = state(&pool, case).await;
    assert_eq!(hq_by, Some(w.hr_one));
    assert_eq!(audits.len(), 2, "{audits:?}");
    assert_eq!(audits[1]["hq_second_person"], "not_required");
    assert_eq!(audits[1]["review_required"], false);
}

/// regression: under route the same non-ops person is refused, and stays refused.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn under_route_the_same_person_is_refused_unless_another_or_ops(pool: PgPool) {
    let w = world(&pool).await;
    live(&pool, &w, true).await;
    let case = hr_confirmed(&w, w.in_a).await;
    for _ in 0..2 {
        let err =
            w.hr.confirm_exit_case(w.hr(w.hr_one), None, case, hq(None))
                .await
                .unwrap_err();
        assert_eq!(err.status, StatusCode::FORBIDDEN);
        assert_eq!(err.code, "exit_hq_second_person_required");
        let (status, hq_by, audits) = state(&pool, case).await;
        assert_eq!(
            (status.as_str(), hq_by, audits.len()),
            ("HR_CONFIRMED", None, 1)
        );
    }
    // Someone else is the second person.
    let done =
        w.hr.confirm_exit_case(w.hr(w.hr_two), None, case, hq(None))
            .await
            .unwrap();
    assert_eq!(done.status, "HQ_CONFIRMED");
    let (_, hq_by, audits) = state(&pool, case).await;
    assert_eq!(hq_by, Some(w.hr_two));
    assert_eq!(audits[1]["hq_second_person"], "distinct");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn under_route_ops_is_the_second_person_only_after_a_bound_step_up(pool: PgPool) {
    let w = world(&pool).await;
    live(&pool, &w, true).await;
    let service = passkey_service();
    let mut key = enroll(&pool, &w, w.hr_one).await;
    let case = hr_confirmed(&w, w.in_a).await;
    let other = hr_confirmed(&w, w.in_b).await;
    let unchanged = |pool: PgPool| async move {
        let (status, hq_by, audits) = state(&pool, case).await;
        assert_eq!(
            (status.as_str(), hq_by, audits.len()),
            ("HR_CONFIRMED", None, 1)
        );
    };

    // Without the verifier the break-glass cannot be checked: refused.
    let err =
        w.hr.confirm_exit_case(ops(&w), None, case, hq(None))
            .await
            .unwrap_err();
    assert_eq!(
        (err.status, err.code),
        (StatusCode::UNAUTHORIZED, "step_up_required")
    );
    let envelope = step_up(&pool, &mut key, exit_hq_binding(case)).await;
    let err =
        w.hr.confirm_exit_case(ops(&w), None, case, hq(Some(envelope)))
            .await
            .unwrap_err();
    assert_eq!(
        (err.status, err.code),
        (StatusCode::SERVICE_UNAVAILABLE, "step_up_unavailable")
    );
    unchanged(pool.clone()).await;

    // No step-up, or one signed for another case: refused, nothing written.
    let err =
        w.hr.confirm_exit_case(ops(&w), Some(&service), case, hq(None))
            .await
            .unwrap_err();
    assert_eq!(
        (err.status, err.code),
        (StatusCode::UNAUTHORIZED, "step_up_required")
    );
    let foreign = step_up(&pool, &mut key, exit_hq_binding(other)).await;
    let err =
        w.hr.confirm_exit_case(ops(&w), Some(&service), case, hq(Some(foreign)))
            .await
            .unwrap_err();
    assert_eq!(
        (err.status, err.code),
        (StatusCode::UNAUTHORIZED, "step_up_failed")
    );
    unchanged(pool.clone()).await;

    // Bound to this case: break-glass, audited, flagged for review.
    let envelope = step_up(&pool, &mut key, exit_hq_binding(case)).await;
    let done =
        w.hr.confirm_exit_case(ops(&w), Some(&service), case, hq(Some(envelope)))
            .await
            .unwrap();
    assert_eq!(done.status, "HQ_CONFIRMED");
    let (_, hq_by, audits) = state(&pool, case).await;
    assert_eq!(hq_by, Some(w.hr_one));
    assert_eq!(audits[1]["hq_second_person"], "ops_break_glass");
    assert_eq!(audits[1]["review_required"], true);
    assert!(audits[1]["step_up_assertion_id"].is_string(), "{audits:?}");
}
