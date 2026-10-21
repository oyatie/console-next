#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Catalog corrections through the same runtime role, Cedar and ledger as other corrections.
mod support;

use console_hr_adapter_postgres::HrError;
use console_hr_adapter_postgres::corrections::{CorrectEmployeeRequest, CorrectionOutcome};
use console_platform_authz::Principal;
use console_platform_test_support::soft_passkey::passkey_service;
use serde_json::{Value, json};
use sqlx::PgPool;
use support::{SECOND, World, world};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

async fn entry(pool: &PgPool, w: &World, kind: &str, label: &str, active: bool) -> Uuid {
    sqlx::query_scalar("INSERT INTO job_titles (org_id, kind, label, active, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id")
        .bind(w.org).bind(kind).bind(label).bind(active).bind(w.hr_one)
        .fetch_one(pool).await.unwrap()
}

async fn correct(
    pool: &PgPool,
    w: &World,
    who: Principal,
    changes: Value,
) -> Result<CorrectionOutcome, HrError> {
    let at: OffsetDateTime = sqlx::query_scalar("SELECT updated_at FROM employees WHERE id = $1")
        .bind(w.in_a)
        .fetch_one(pool)
        .await
        .unwrap();
    let body: CorrectEmployeeRequest = serde_json::from_value(json!({
        "expected_updated_at": at.format(&Rfc3339).unwrap(), "changes": changes, "reason_code": "INPUT_ERROR",
    })).unwrap();
    w.hr.correct_employee(who, &passkey_service(), w.in_a, body, SECOND)
        .await
}

async fn state(pool: &PgPool, employee: Uuid) -> (Option<Uuid>, OffsetDateTime, i64, i64, i64) {
    sqlx::query_as("SELECT grade_id, updated_at, (SELECT count(*) FROM employee_corrections WHERE employee_id = $1), (SELECT count(*) FROM employee_lifecycle_events WHERE employee_id = $1), (SELECT count(*) FROM audit_events WHERE target_id = $1::text AND action = 'employee.correct') FROM employees WHERE id = $1")
        .bind(employee).fetch_one(pool).await.unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn grade_correction_changes_the_head_and_keeps_both_ids_without_a_promotion(pool: PgPool) {
    let w = world(&pool).await;
    let old = entry(&pool, &w, "GRADE", "G1", true).await;
    let new = entry(&pool, &w, "GRADE", "G2", true).await;
    correct(&pool, &w, w.hr(w.hr_one), json!({"grade_id": old}))
        .await
        .unwrap();
    let before = state(&pool, w.in_a).await;
    let done = correct(&pool, &w, w.hr(w.hr_one), json!({"grade_id": new}))
        .await
        .unwrap();
    assert_eq!(done.applied, ["grade_id"]);
    assert!(done.pending_request.is_none());
    let after = state(&pool, w.in_a).await;
    assert_eq!(after.0, Some(new));
    assert!(after.1 > before.1);
    assert_eq!((after.2, after.3), (before.2 + 1, before.3));
    let ledger: (Value, Value) = sqlx::query_as("SELECT old_value, new_value FROM employee_corrections WHERE employee_id = $1 AND new_value = $2")
        .bind(w.in_a).bind(json!(new)).fetch_one(&pool).await.unwrap();
    assert_eq!(ledger, (json!(old), json!(new)));
    assert_eq!(after.4, before.4 + 1);
    let audit: (Value, Value) = sqlx::query_as("SELECT before_snap, after_snap FROM audit_events WHERE target_id = $1 AND action = 'employee.correct' ORDER BY occurred_at DESC LIMIT 1")
        .bind(w.in_a.to_string()).fetch_one(&pool).await.unwrap();
    assert_eq!(audit.0["classification"]["grade_id"], json!(old));
    assert_eq!(audit.1["classification"]["grade_id"], json!(new));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn inactive_wrong_kind_and_unknown_grades_are_refused_atomically(pool: PgPool) {
    let w = world(&pool).await;
    let inactive = entry(&pool, &w, "GRADE", "Old", false).await;
    let wrong = entry(&pool, &w, "TITLE", "Staff", true).await;
    let before = state(&pool, w.in_a).await;
    for id in [inactive, wrong, Uuid::new_v4()] {
        let error = correct(
            &pool,
            &w,
            w.hr(w.hr_one),
            json!({"grade_id": id, "name": "Unchanged"}),
        )
        .await
        .unwrap_err();
        assert_eq!(
            (error.status.as_u16(), error.code),
            (422, "job_title_unknown")
        );
        assert_eq!(state(&pool, w.in_a).await, before);
        let filed =
            w.hr.create_change_request(
                w.admin(w.admin_a, w.branch_a),
                support::create(
                    "PROFILE_CORRECTION",
                    "EMPLOYEE",
                    w.in_a,
                    json!({"changes": {"grade_id": id}}),
                ),
            )
            .await
            .unwrap_err();
        assert_eq!(
            (filed.status.as_u16(), filed.code),
            (422, "job_title_unknown")
        );
        let name: String = sqlx::query_scalar("SELECT name FROM employees WHERE id = $1")
            .bind(w.in_a)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(name, "E");
    }
    for value in [json!("not-a-uuid"), Value::Null, json!(7)] {
        let error = correct(&pool, &w, w.hr(w.hr_one), json!({"grade_id": value}))
            .await
            .unwrap_err();
        assert_eq!(error.status.as_u16(), 422);
        assert_eq!(state(&pool, w.in_a).await, before);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn catalog_corrections_keep_tenant_and_cedar_boundaries(pool: PgPool) {
    let w = world(&pool).await;
    let foreign = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, 'other-catalog', 'Other')")
        .bind(foreign)
        .execute(&pool)
        .await
        .unwrap();
    let foreign_user = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, org_id, display_name, roles) VALUES ($1, $2, 'Foreign', ARRAY['SUPER_ADMIN'])")
        .bind(foreign_user).bind(foreign).execute(&pool).await.unwrap();
    let id: Uuid = sqlx::query_scalar("INSERT INTO job_titles (org_id, kind, label, created_by) VALUES ($1, 'GRADE', 'Foreign', $2) RETURNING id")
        .bind(foreign).bind(foreign_user).fetch_one(&pool).await.unwrap();
    let before = state(&pool, w.in_a).await;
    let error = correct(&pool, &w, w.hr(w.hr_one), json!({"grade_id": id}))
        .await
        .unwrap_err();
    assert_eq!(
        (error.status.as_u16(), error.code),
        (422, "job_title_unknown")
    );
    let local = entry(&pool, &w, "GRADE", "Local", true).await;
    let error = correct(
        &pool,
        &w,
        w.admin(w.admin_a, w.branch_a),
        json!({"grade_id": local}),
    )
    .await
    .unwrap_err();
    assert_eq!((error.status.as_u16(), error.code), (403, "forbidden"));
    assert_eq!(state(&pool, w.in_a).await, before);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn other_catalog_fields_correct_their_ids_and_display_twins(pool: PgPool) {
    let w = world(&pool).await;
    let title = entry(&pool, &w, "TITLE", "Senior", true).await;
    let role = entry(&pool, &w, "POSITION", "Lead", true).await;
    let job = entry(&pool, &w, "JOB", "Design", true).await;
    let family = entry(&pool, &w, "JOB_FAMILY", "Engineering", true).await;
    correct(&pool, &w, w.hr(w.hr_one), json!({"job_title_id": title, "position_kind_id": role, "job_id": job, "job_family_id": family})).await.unwrap();
    let row: (Option<Uuid>, Option<Uuid>, Option<Uuid>, Option<Uuid>, String, String) = sqlx::query_as("SELECT job_title_id, position_kind_id, job_id, job_family_id, position, job FROM employees WHERE id = $1")
        .bind(w.in_a).fetch_one(&pool).await.unwrap();
    assert_eq!(
        row,
        (
            Some(title),
            Some(role),
            Some(job),
            Some(family),
            "Senior".into(),
            "Design".into()
        )
    );
}
