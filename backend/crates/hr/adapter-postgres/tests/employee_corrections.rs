#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! BW-18 corrections and identity resolution, run as the runtime role
//! `console_rt` (RLS armed, column grants as in production).

mod support;

use console_hr_adapter_postgres::corrections::SecondPersonContext;
use console_hr_adapter_postgres::corrections::identity::ResolveIdentityRequest;
use console_platform_test_support::soft_passkey::passkey_service;
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use support::{World, create, decide, world};

const SECOND: SecondPersonContext = SecondPersonContext {
    other_eligible_holders: 1,
    routed: true,
    sole_holder_refuse: false,
};

async fn head(pool: &PgPool, id: Uuid) -> (String, Option<String>, OffsetDateTime, bool) {
    sqlx::query_as(
        "SELECT name, hire_date, updated_at, identity_review_required FROM employees WHERE id = $1",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .unwrap()
}

fn patch(
    updated_at: OffsetDateTime,
    changes: Value,
) -> console_hr_adapter_postgres::corrections::CorrectEmployeeRequest {
    serde_json::from_value(json!({
        "expected_updated_at": updated_at.format(&Rfc3339).unwrap(),
        "changes": changes,
        "reason_code": "DATA_ENTRY_ERROR",
    }))
    .unwrap()
}

async fn ledger(pool: &PgPool, id: Uuid) -> Vec<(String, Value, Option<Uuid>, Uuid, bool)> {
    sqlx::query_as(
        "SELECT field, new_value, change_request_id, corrected_by, review_required \
         FROM employee_corrections WHERE employee_id = $1 ORDER BY created_at, field",
    )
    .bind(id)
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn correct(
    w: &World,
    pool: &PgPool,
    changes: Value,
    holders: SecondPersonContext,
) -> Result<
    console_hr_adapter_postgres::corrections::CorrectionOutcome,
    console_hr_adapter_postgres::HrError,
> {
    let (_, _, updated_at, _) = head(pool, w.in_a).await;
    w.hr.correct_employee(
        w.hr(w.hr_one),
        &passkey_service(),
        w.in_a,
        patch(updated_at, changes),
        holders,
    )
    .await
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_name_applies_at_once_and_a_stale_version_is_409(pool: PgPool) {
    let w = world(&pool).await;
    let (_, _, before, _) = head(&pool, w.in_a).await;
    let done = correct(&w, &pool, json!({"name": " 김정정 "}), SECOND)
        .await
        .unwrap();
    assert_eq!(
        (done.applied.clone(), done.pending_request.is_none()),
        (vec!["name".to_owned()], true)
    );
    let (name, _, after, _) = head(&pool, w.in_a).await;
    assert_eq!((name.as_str(), after == done.updated_at), ("김정정", true));
    assert!(after > before);
    assert_eq!(
        ledger(&pool, w.in_a).await,
        vec![("name".into(), json!("김정정"), None, w.hr_one, false)]
    );

    let err =
        w.hr.correct_employee(
            w.hr(w.hr_one),
            &passkey_service(),
            w.in_a,
            patch(before, json!({"name": "X"})),
            SECOND,
        )
        .await
        .unwrap_err();
    assert_eq!(err.status, StatusCode::CONFLICT);

    // Branch admins file a change request instead.
    let err =
        w.hr.correct_employee(
            w.admin(w.admin_a, w.branch_a),
            &passkey_service(),
            w.in_a,
            patch(after, json!({"name": "X"})),
            SECOND,
        )
        .await
        .unwrap_err();
    assert_eq!(err.status, StatusCode::FORBIDDEN);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_hire_date_waits_for_a_second_person_who_applies_it(pool: PgPool) {
    let w = world(&pool).await;
    // A recorded hire date: a first recording would apply at once (MR-8).
    sqlx::query("UPDATE employees SET hire_date = '2024-01-01' WHERE id = $1")
        .bind(w.in_a)
        .execute(&pool)
        .await
        .unwrap();
    let done = correct(&w, &pool, json!({"hire_date": "2024-03-01"}), SECOND)
        .await
        .unwrap();
    let request = done.pending_request.expect("a pending PROFILE_CORRECTION");
    assert_eq!(
        (request.kind.as_str(), request.status.as_str()),
        ("PROFILE_CORRECTION", "OPEN")
    );
    assert!(done.applied.is_empty());
    assert_eq!(head(&pool, w.in_a).await.1.as_deref(), Some("2024-01-01"));

    let applied =
        w.hr.decide_change_request(w.hr(w.hr_two), request.id, decide("APPLY"), support::SECOND)
            .await
            .unwrap();
    assert_eq!(applied.status, "APPLIED");
    assert_eq!(head(&pool, w.in_a).await.1.as_deref(), Some("2024-03-01"));
    assert_eq!(
        ledger(&pool, w.in_a).await,
        vec![(
            "hire_date".into(),
            json!("2024-03-01"),
            Some(request.id),
            w.hr_two,
            false
        )]
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn position_fails_closed_and_a_future_hire_date_is_invalid(pool: PgPool) {
    let w = world(&pool).await;
    let err = correct(&w, &pool, json!({ "position_id": "x" }), SECOND)
        .await
        .unwrap_err();
    assert_eq!(err.status, StatusCode::CONFLICT);
    let err =
        w.hr.create_change_request(
            w.admin(w.admin_a, w.branch_a),
            create(
                "PROFILE_CORRECTION",
                "EMPLOYEE",
                w.in_a,
                json!({"changes": { "position_id": "x" }}),
            ),
        )
        .await
        .unwrap_err();
    assert_eq!(
        (err.status, err.code),
        (StatusCode::CONFLICT, "employee_correction_unavailable")
    );
    let err = correct(&w, &pool, json!({"hire_date": "2999-01-01"}), SECOND)
        .await
        .unwrap_err();
    assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
    // A request is filed only with values the second person can apply.
    let err =
        w.hr.create_change_request(
            w.admin(w.admin_a, w.branch_a),
            create(
                "PROFILE_CORRECTION",
                "EMPLOYEE",
                w.in_a,
                json!({"changes": { "hire_date": "2999-01-01" }}),
            ),
        )
        .await
        .unwrap_err();
    assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
}

fn resolve(body: Value) -> ResolveIdentityRequest {
    serde_json::from_value(body).unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn different_clears_review_and_same_needs_a_step_up(pool: PgPool) {
    let w = world(&pool).await;
    let passkeys = passkey_service();
    assert!(head(&pool, w.in_a).await.3);
    let err =
        w.hr.resolve_identity(
            w.hr(w.hr_one),
            &passkeys,
            w.in_a,
            resolve(
                json!({"verdict": "SAME", "keep_employee_id": w.in_b, "reason_code": "DUPLICATE"}),
            ),
            SECOND,
        )
        .await
        .unwrap_err();
    assert_eq!(
        (err.status, err.code),
        (StatusCode::UNAUTHORIZED, "step_up_required")
    );

    let done =
        w.hr.resolve_identity(
            w.hr(w.hr_one),
            &passkeys,
            w.in_a,
            resolve(json!({"verdict": "DIFFERENT", "reason_code": "VERIFIED_DIFFERENT"})),
            SECOND,
        )
        .await
        .unwrap();
    assert_eq!(
        (done.verdict, done.merged_into_employee_id),
        ("DIFFERENT", None)
    );
    assert!(!head(&pool, w.in_a).await.3);
    let err =
        w.hr.resolve_identity(
            w.hr(w.hr_one),
            &passkeys,
            w.in_a,
            resolve(json!({"verdict": "DIFFERENT", "reason_code": "VERIFIED_DIFFERENT"})),
            SECOND,
        )
        .await
        .unwrap_err();
    assert_eq!(
        (err.status, err.code),
        (StatusCode::CONFLICT, "identity_review_not_required")
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_hand_filed_merge_without_the_requesters_step_up_never_applies(pool: PgPool) {
    let w = world(&pool).await;
    let forged =
        w.hr.create_change_request(
            w.hr(w.hr_one),
            create(
                "IDENTITY_REVIEW",
                "EMPLOYEE",
                w.in_a,
                json!({"verdict": "SAME", "keep_employee_id": w.in_b, "step_up_assertion_id": Uuid::new_v4()}),
            ),
        )
        .await
        .unwrap();
    let err =
        w.hr.decide_change_request(w.hr(w.hr_two), forged.id, decide("APPLY"), support::SECOND)
            .await
            .unwrap_err();
    assert_eq!(
        (err.status, err.code),
        (StatusCode::CONFLICT, "identity_merge_step_up_missing")
    );
    assert!(head(&pool, w.in_a).await.3);
}
