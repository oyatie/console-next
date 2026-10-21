#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! BW-18 corrections of the employment-profile fields (phone, employment
//! type, base pay) on the EMP-MODEL columns, as the runtime role `console_rt`.

mod support;

use console_platform_test_support::soft_passkey::passkey_service;

use console_hr_adapter_postgres::HrError;
use console_hr_adapter_postgres::corrections::{
    CorrectEmployeeRequest, CorrectionOutcome, SecondPersonContext,
};
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use support::{World, decide, world};

const SECOND: SecondPersonContext = SecondPersonContext {
    other_eligible_holders: 1,
    routed: true,
    sole_holder_refuse: false,
};

/// The console-created profile of `employee` (imported records have none).
async fn give_profile(pool: &PgPool, w: &World, employee: Uuid) {
    sqlx::query(
        "INSERT INTO employee_employment_profiles (employee_id, org_id, employment_type, \
         phone_e164, base_pay, idempotency_key, request_hash, created_by) \
         VALUES ($1, $2, 'REGULAR', '+821012345678', 3000000, $3, repeat('a', 64), $4)",
    )
    .bind(employee)
    .bind(w.org)
    .bind(format!("key-{employee}"))
    .bind(w.hr_one)
    .execute(pool)
    .await
    .unwrap();
}

async fn profile(pool: &PgPool, employee: Uuid) -> (String, String, String) {
    sqlx::query_as(
        "SELECT phone_e164, employment_type, base_pay::bigint::text FROM employee_employment_profiles \
         WHERE employee_id = $1",
    )
    .bind(employee)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn correct(
    w: &World,
    pool: &PgPool,
    changes: Value,
    holders: SecondPersonContext,
) -> Result<CorrectionOutcome, HrError> {
    let updated_at: OffsetDateTime =
        sqlx::query_scalar("SELECT updated_at FROM employees WHERE id = $1")
            .bind(w.in_a)
            .fetch_one(pool)
            .await
            .unwrap();
    let body: CorrectEmployeeRequest = serde_json::from_value(json!({
        "expected_updated_at": updated_at.format(&Rfc3339).unwrap(),
        "changes": changes,
        "reason_code": "DATA_ENTRY_ERROR",
    }))
    .unwrap();
    w.hr.correct_employee(w.hr(w.hr_one), &passkey_service(), w.in_a, body, holders)
        .await
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_record_without_a_profile_names_the_gap(pool: PgPool) {
    let w = world(&pool).await;
    let err = correct(&w, &pool, json!({"phone": "010-1234-0002"}), SECOND)
        .await
        .unwrap_err();
    assert_eq!(
        (err.status, err.code),
        (StatusCode::CONFLICT, "employee_profile_missing")
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn phone_applies_at_once_and_type_and_pay_wait_for_a_second_person(pool: PgPool) {
    let w = world(&pool).await;
    give_profile(&pool, &w, w.in_a).await;
    let done = correct(
        &w,
        &pool,
        json!({"phone": "010-1234-0002", "employment_type": "contract", "base_pay": 3_200_000}),
        SECOND,
    )
    .await
    .unwrap();
    assert_eq!(done.applied, vec!["phone".to_owned()]);
    let request = done.pending_request.expect("type and pay wait");
    assert_eq!(
        request.payload["changes"],
        json!({"base_pay": "3200000", "employment_type": "CONTRACT"})
    );
    assert_eq!(
        profile(&pool, w.in_a).await,
        ("+821012340002".into(), "REGULAR".into(), "3000000".into())
    );

    w.hr.decide_change_request(w.hr(w.hr_two), request.id, decide("APPLY"), support::SECOND)
        .await
        .unwrap();
    assert_eq!(
        profile(&pool, w.in_a).await,
        ("+821012340002".into(), "CONTRACT".into(), "3200000".into())
    );
    let old: Option<Value> = sqlx::query_scalar(
        "SELECT old_value FROM employee_corrections WHERE employee_id = $1 AND field = 'base_pay'",
    )
    .bind(w.in_a)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(old.is_some());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn invalid_profile_values_are_422(pool: PgPool) {
    let w = world(&pool).await;
    give_profile(&pool, &w, w.in_a).await;
    for changes in [
        json!({"employment_type": "SEASONAL"}),
        json!({"base_pay": "3,000,000"}),
        json!({"base_pay": -1}),
        json!({"phone": "12"}),
    ] {
        let err = correct(&w, &pool, changes.clone(), SECOND)
            .await
            .unwrap_err();
        assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY, "{changes}");
    }
}
