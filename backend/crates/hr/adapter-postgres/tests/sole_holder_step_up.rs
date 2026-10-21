#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Decisions #7 case B with a real soft passkey: a sole HR holder applies a
//! high-risk 정정 or an identity merge only after a step-up bound to that
//! exact payload; Cedar `change_request_decide` admits the self-decision.

mod support;

use console_hr_adapter_postgres::corrections::identity::ResolveIdentityRequest;
use console_hr_adapter_postgres::corrections::merge::merge_binding;
use console_hr_adapter_postgres::corrections::patch::correction_binding;
use console_hr_adapter_postgres::corrections::{CorrectEmployeeRequest, SecondPersonContext};
use console_platform_auth::MobilePasskeyStepUpEnvelope;
use console_platform_test_support::soft_passkey::passkey_service;
use http::StatusCode;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use support::passkey::{enroll, step_up};
use support::{World, world};

const SOLE: SecondPersonContext = SecondPersonContext {
    other_eligible_holders: 0,
    routed: true,
    sole_holder_refuse: false,
};

/// A recorded hire date: a first recording needs no second person (MR-8),
/// so the sole-holder path is exercised on a 정정 of a recorded value.
async fn recorded_hire_date(pool: &PgPool, id: Uuid) {
    sqlx::query("UPDATE employees SET hire_date = '2024-01-01' WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
}

async fn updated_at(pool: &PgPool, id: Uuid) -> OffsetDateTime {
    sqlx::query_scalar("SELECT updated_at FROM employees WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

fn changes(hire_date: &str) -> Map<String, Value> {
    json!({ "hire_date": hire_date })
        .as_object()
        .unwrap()
        .clone()
}

async fn patch(
    pool: &PgPool,
    w: &World,
    sent: &str,
    envelope: MobilePasskeyStepUpEnvelope,
) -> CorrectEmployeeRequest {
    CorrectEmployeeRequest {
        expected_updated_at: updated_at(pool, w.in_a).await.format(&Rfc3339).unwrap(),
        changes: changes(sent),
        reason_code: "DATA_ENTRY_ERROR".into(),
        note: None,
        step_up: Some(envelope),
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_sole_holder_correction_applies_only_with_a_step_up_for_that_payload(pool: PgPool) {
    let w = world(&pool).await;
    recorded_hire_date(&pool, w.in_a).await;
    let mut key = enroll(&pool, &w, w.hr_one).await;
    let service = passkey_service();

    // A step-up signed for another value never applies this one.
    let other = step_up(
        &pool,
        &mut key,
        correction_binding(w.in_a, &changes("2024-03-02")),
    )
    .await;
    let body = patch(&pool, &w, "2024-03-01", other).await;
    let err =
        w.hr.correct_employee(w.hr(w.hr_one), &service, w.in_a, body, SOLE)
            .await
            .unwrap_err();
    assert_eq!(
        (err.status, err.code),
        (StatusCode::UNAUTHORIZED, "step_up_failed")
    );

    let bound = step_up(
        &pool,
        &mut key,
        correction_binding(w.in_a, &changes("2024-03-01")),
    )
    .await;
    let body = patch(&pool, &w, "2024-03-01", bound).await;
    let done =
        w.hr.correct_employee(w.hr(w.hr_one), &service, w.in_a, body, SOLE)
            .await
            .unwrap();
    assert_eq!(
        (
            done.applied.clone(),
            done.review_required,
            done.pending_request.is_none()
        ),
        (vec!["hire_date".to_owned()], true, true)
    );
    let (hire_date, review): (Option<String>, bool) = sqlx::query_as(
        "SELECT e.hire_date, c.review_required FROM employees e \
         JOIN employee_corrections c ON c.employee_id = e.id WHERE e.id = $1",
    )
    .bind(w.in_a)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((hire_date.as_deref(), review), (Some("2024-03-01"), true));
    let recorded: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM step_up_assertions \
         WHERE object_id = $1 AND action_kind = 'EXCEPTION_DECIDE'",
    )
    .bind(w.in_a)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(recorded, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_sole_holder_merge_applies_with_the_review_flag(pool: PgPool) {
    let w = world(&pool).await;
    let mut key = enroll(&pool, &w, w.hr_one).await;
    let envelope = step_up(&pool, &mut key, merge_binding(w.in_a, w.in_b)).await;
    let body: ResolveIdentityRequest = serde_json::from_value(json!({
        "verdict": "SAME", "keep_employee_id": w.in_b, "reason_code": "DUPLICATE"
    }))
    .unwrap();
    let body = ResolveIdentityRequest {
        step_up: Some(envelope),
        ..body
    };
    let done =
        w.hr.resolve_identity(w.hr(w.hr_one), &passkey_service(), w.in_a, body, SOLE)
            .await
            .unwrap();
    assert_eq!(
        (done.merged_into_employee_id, done.review_required),
        (Some(w.in_b), true)
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_sole_holder_needs_a_step_up_or_is_refused_by_the_mode(pool: PgPool) {
    let w = world(&pool).await;
    recorded_hire_date(&pool, w.in_a).await;
    let body = |at: OffsetDateTime| CorrectEmployeeRequest {
        expected_updated_at: at.format(&Rfc3339).unwrap(),
        changes: changes("2024-03-01"),
        reason_code: "DATA_ENTRY_ERROR".into(),
        note: None,
        step_up: None,
    };
    let refuse = SecondPersonContext {
        sole_holder_refuse: true,
        ..SOLE
    };
    for (holders, expected) in [
        (
            refuse,
            (
                StatusCode::FORBIDDEN,
                "employee_correction_sole_holder_refused",
            ),
        ),
        (SOLE, (StatusCode::UNAUTHORIZED, "step_up_required")),
    ] {
        let at = updated_at(&pool, w.in_a).await;
        let err =
            w.hr.correct_employee(
                w.hr(w.hr_one),
                &passkey_service(),
                w.in_a,
                body(at),
                holders,
            )
            .await
            .unwrap_err();
        assert_eq!((err.status, err.code), expected);
    }
    let ledger: i64 =
        sqlx::query_scalar("SELECT count(*) FROM employee_corrections WHERE employee_id = $1")
            .bind(w.in_a)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(ledger, 0);
}

/// decisions #26: under `approval.policy.people_correction = none` the actor
/// applies a high-risk 정정 after the step-up even while other holders exist
/// and the sole-holder mode refuses: no BW-17 request is filed.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn approval_policy_none_applies_with_a_step_up_whoever_else_holds_it(pool: PgPool) {
    let w = world(&pool).await;
    recorded_hire_date(&pool, w.in_a).await;
    let mut key = enroll(&pool, &w, w.hr_one).await;
    let none = SecondPersonContext {
        other_eligible_holders: 2,
        routed: false,
        sole_holder_refuse: true,
    };
    let bound = step_up(
        &pool,
        &mut key,
        correction_binding(w.in_a, &changes("2024-03-01")),
    )
    .await;
    let body = patch(&pool, &w, "2024-03-01", bound).await;
    let done =
        w.hr.correct_employee(w.hr(w.hr_one), &passkey_service(), w.in_a, body, none)
            .await
            .unwrap();
    assert_eq!(
        (
            done.applied,
            done.review_required,
            done.pending_request.is_none()
        ),
        (vec!["hire_date".to_owned()], true, true)
    );
}
