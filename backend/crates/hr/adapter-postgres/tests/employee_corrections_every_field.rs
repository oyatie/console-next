#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! MR-8: one correction path for every scalar employee field, with the
//! ledger, run as the runtime role `console_rt`.

mod support;

use console_hr_adapter_postgres::HrError;
use console_hr_adapter_postgres::corrections::{
    CorrectEmployeeRequest, CorrectionOutcome, SecondPersonContext,
};
use console_platform_test_support::soft_passkey::passkey_service;
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use support::{World, decide, world};

const SECOND: SecondPersonContext = support::SECOND;

/// Owner-side fixture write (triggers off, like the support fixture).
async fn owner(pool: &PgPool, sql: &'static str, id: Uuid) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query(sql)
        .bind(id)
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

async fn correct(w: &World, pool: &PgPool, changes: Value) -> Result<CorrectionOutcome, HrError> {
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
    w.hr.correct_employee(w.hr(w.hr_one), &passkey_service(), w.in_a, body, SECOND)
        .await
}

async fn text(pool: &PgPool, column: &str, id: Uuid) -> Option<String> {
    sqlx::query_scalar("SELECT to_jsonb(e) ->> $2 FROM employees e WHERE id = $1")
        .bind(id)
        .bind(column)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn ledger(pool: &PgPool, id: Uuid, field: &str) -> Vec<(Option<Value>, Value)> {
    sqlx::query_as(
        "SELECT old_value, new_value FROM employee_corrections \
         WHERE employee_id = $1 AND field = $2 ORDER BY created_at",
    )
    .bind(id)
    .bind(field)
    .fetch_all(pool)
    .await
    .unwrap()
}

fn refused(result: Result<CorrectionOutcome, HrError>) -> (StatusCode, &'static str) {
    let err = result.unwrap_err();
    (err.status, err.code)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn low_fields_apply_at_once_and_keep_their_old_values(pool: PgPool) {
    let w = world(&pool).await;
    owner(
        &pool,
        "UPDATE employees SET job = '현장' WHERE id = $1",
        w.in_a,
    )
    .await;
    let done = correct(
        &w,
        &pool,
        json!({"job": " 설비 관리 ", "work_email": " Kim@Corp.EXAMPLE ", "id_type": "arc"}),
    )
    .await
    .unwrap();
    assert!(done.pending_request.is_none());
    assert_eq!(done.applied.len(), 3);
    assert_eq!(
        text(&pool, "job", w.in_a).await.as_deref(),
        Some("설비 관리")
    );
    assert_eq!(text(&pool, "id_type", w.in_a).await.as_deref(), Some("ARC"));
    assert_eq!(
        ledger(&pool, w.in_a, "job").await,
        vec![(Some(json!("현장")), json!("설비 관리"))]
    );
    assert_eq!(
        ledger(&pool, w.in_a, "work_email").await,
        vec![(None, json!("Kim@corp.example"))]
    );

    correct(&w, &pool, json!({"job": null})).await.unwrap();
    assert_eq!(text(&pool, "job", w.in_a).await, None);
    assert_eq!(
        ledger(&pool, w.in_a, "job").await[1],
        (Some(json!("설비 관리")), Value::Null)
    );
    assert_eq!(
        refused(correct(&w, &pool, json!({"employee_number": null})).await).0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_first_recording_applies_and_a_recorded_value_waits(pool: PgPool) {
    let w = world(&pool).await;
    let first = correct(
        &w,
        &pool,
        json!({"birth_date": "1990-05-01", "employee_number": "E-100"}),
    )
    .await
    .unwrap();
    assert!(first.pending_request.is_none());
    assert_eq!(
        text(&pool, "birth_date", w.in_a).await.as_deref(),
        Some("1990-05-01")
    );

    let again = correct(&w, &pool, json!({"birth_date": "1990-05-02"}))
        .await
        .unwrap();
    let request = again.pending_request.expect("a recorded birth date waits");
    assert_eq!(
        text(&pool, "birth_date", w.in_a).await.as_deref(),
        Some("1990-05-01")
    );
    w.hr.decide_change_request(w.hr(w.hr_two), request.id, decide("APPLY"), SECOND)
        .await
        .unwrap();
    assert_eq!(
        text(&pool, "birth_date", w.in_a).await.as_deref(),
        Some("1990-05-02")
    );
    assert_eq!(
        ledger(&pool, w.in_a, "birth_date").await,
        vec![
            (None, json!("1990-05-01")),
            (Some(json!("1990-05-01")), json!("1990-05-02"))
        ]
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_employee_number_must_be_free(pool: PgPool) {
    let w = world(&pool).await;
    owner(
        &pool,
        "UPDATE employees SET employee_number = 'E-7' WHERE id = $1",
        w.in_b,
    )
    .await;
    assert_eq!(
        refused(correct(&w, &pool, json!({"employee_number": "E-7"})).await),
        (StatusCode::CONFLICT, "employee_number_in_use")
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn placement_text_points_at_the_assignment(pool: PgPool) {
    let w = world(&pool).await;
    for field in ["company", "worksite_name", "worksite_address", "org_unit"] {
        assert_eq!(
            refused(
                correct(
                    &w,
                    &pool,
                    Value::Object([(field.to_owned(), json!("X"))].into_iter().collect())
                )
                .await
            ),
            (StatusCode::CONFLICT, "employee_correction_unavailable"),
            "{field}"
        );
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_exit_date_is_corrected_only_on_an_exited_record_without_an_exit_case(pool: PgPool) {
    let w = world(&pool).await;
    assert_eq!(
        refused(correct(&w, &pool, json!({"exit_date": "2026-01-31"})).await),
        (StatusCode::CONFLICT, "exit_date_needs_exit")
    );
    owner(
        &pool,
        "UPDATE employees SET employment_status = 'EXITED', hire_date = '2020-01-01', \
         exit_date = '2026-01-30' WHERE id = $1",
        w.in_a,
    )
    .await;
    assert_eq!(
        refused(correct(&w, &pool, json!({"exit_date": "2019-12-31"})).await).0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let request = correct(&w, &pool, json!({"exit_date": "2026-01-31"}))
        .await
        .unwrap()
        .pending_request
        .expect("a recorded exit date waits");
    w.hr.decide_change_request(w.hr(w.hr_two), request.id, decide("APPLY"), SECOND)
        .await
        .unwrap();
    assert_eq!(
        text(&pool, "exit_date", w.in_a).await.as_deref(),
        Some("2026-01-31")
    );
    assert_eq!(
        text(&pool, "exit_on", w.in_a).await.as_deref(),
        Some("2026-01-31")
    );

    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO employee_exit_cases (org_id, employee_id, effective_exit_date, \
         site_manager_note, reported_by) VALUES ($1, $2, '2026-01-31', 'n', $3)",
    )
    .bind(w.org)
    .bind(w.in_a)
    .bind(w.hr_one)
    .execute(tx.as_mut())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        refused(correct(&w, &pool, json!({"exit_date": "2026-02-01"})).await),
        (StatusCode::CONFLICT, "exit_case_owns_exit_date")
    );
}
