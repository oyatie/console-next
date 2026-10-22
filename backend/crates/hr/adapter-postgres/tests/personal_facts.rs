// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! MR-34: the 인적사항 extras through the MR-8 ledger (one by one and in
//! bulk) and the 그룹 입사일's second person and hire bound, as the runtime
//! role `console_rt`. The 사진 gate is proved in hr-rest `photo_http.rs`.

#[path = "personal_facts/evidence.rs"]
mod evidence;
#[path = "personal_facts/notice.rs"]
mod notice;
mod support;

use console_hr_adapter_postgres::HrError;
use console_hr_adapter_postgres::corrections::{CorrectEmployeeRequest, CorrectionOutcome};
use console_hr_adapter_postgres::register_facts::bulk::BulkRegisterFactsRequest;
use console_platform_test_support::soft_passkey::passkey_service;
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use support::{SECOND, World, create, decide, world};

async fn correct_on(
    pool: &PgPool,
    w: &World,
    employee: Uuid,
    changes: Value,
) -> Result<CorrectionOutcome, HrError> {
    let at: OffsetDateTime = sqlx::query_scalar("SELECT updated_at FROM employees WHERE id = $1")
        .bind(employee)
        .fetch_one(pool)
        .await
        .unwrap();
    let body: CorrectEmployeeRequest = serde_json::from_value(json!({
        "expected_updated_at": at.format(&Rfc3339).unwrap(),
        "changes": changes,
        "reason_code": "DATA_ENTRY_ERROR",
    }))
    .unwrap();
    w.hr.correct_employee(w.hr(w.hr_one), &passkey_service(), employee, body, SECOND)
        .await
}

async fn ledger(pool: &PgPool, employee: Uuid) -> Vec<(String, Option<Value>, Value)> {
    sqlx::query_as(
        "SELECT field, old_value, new_value FROM employee_corrections \
         WHERE employee_id = $1 ORDER BY created_at, field",
    )
    .bind(employee)
    .fetch_all(pool)
    .await
    .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn personal_items_are_corrected_through_the_ledger_and_read_back(pool: PgPool) {
    let w = world(&pool).await;
    let two = json!([
        { "name": "이하나", "relation": "SPOUSE", "phone": "010-1234-5678", "contact_notified": true },
        { "name": "이두리", "relation": "PARENT", "phone": "+82 2 123 4567", "contact_notified": true },
    ]);
    let done = correct_on(
        &pool,
        &w,
        w.in_a,
        json!({
            "name_hanja": "金河娜", "name_en": "KIM HANA", "nationality": "kr",
            "personal_email": "Hana@Example.com", "emergency_contacts": two,
        }),
    )
    .await
    .unwrap();
    assert!(
        done.pending_request.is_none(),
        "first recordings apply at once"
    );
    let rows = ledger(&pool, w.in_a).await;
    assert_eq!(rows.len(), 5);
    assert!(rows.iter().all(|(_, old, _)| old.is_none()));

    let one = json!([{ "name": "이하나", "relation": "SPOUSE", "phone": "01012345678", "contact_notified": true }]);
    correct_on(
        &pool,
        &w,
        w.in_a,
        json!({ "emergency_contacts": one, "personal_email": null }),
    )
    .await
    .unwrap();
    let facts = w.hr.personal_facts(w.hr(w.hr_one), w.in_a).await.unwrap();
    assert_eq!(facts.name_hanja.as_deref(), Some("金河娜"));
    assert_eq!(facts.name_en.as_deref(), Some("KIM HANA"));
    assert_eq!(facts.nationality.as_deref(), Some("KR"));
    assert_eq!(facts.personal_email, None, "cleared back to 미입력");
    assert_eq!(facts.emergency_contacts.as_array().unwrap().len(), 1);
    let first = &facts.emergency_contacts[0];
    assert_eq!(first["name"], "이하나");
    assert_eq!(first["relation"], "SPOUSE");
    assert_eq!(first["phone"], "+821012345678");
    assert_eq!(first["basis"], "VITAL_INTEREST_PENDING_COUNSEL");
    assert!(first.get("basis_label").is_none());
    assert_eq!(first["recorded_by"], w.hr_one.to_string());
    let recorder: String = sqlx::query_scalar("SELECT display_name FROM users WHERE id = $1")
        .bind(w.hr_one)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(first["recorded_by_name"], recorder);
    assert!(first["recorded_at"].as_str().is_some_and(|s| !s.is_empty()));
    assert_eq!(first["contact_notified"], true);
    let voided: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM employee_emergency_contacts WHERE employee_id = $1 AND voided_at IS NOT NULL",
    )
    .bind(w.in_a)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(voided, 1, "only the removed contact is voided");
    let last = ledger(&pool, w.in_a).await;
    let contacts = last
        .iter()
        .rfind(|row| row.0 == "emergency_contacts")
        .unwrap();
    assert_eq!(contacts.1.as_ref().unwrap()[1]["phone"], "+8221234567");
    let email = last.iter().rfind(|row| row.0 == "personal_email").unwrap();
    assert_eq!(
        (email.1.clone(), email.2.clone()),
        (Some(json!("Hana@example.com")), Value::Null)
    );

    let err = correct_on(&pool, &w, w.in_a, json!({ "nationality": "KOR" }))
        .await
        .unwrap_err();
    assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
    let reader = w.admin(w.admin_a, w.branch_a);
    assert!(
        w.hr.personal_facts(reader, w.in_a).await.is_err(),
        "manage only"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_group_service_start_stays_before_the_hire_and_a_change_needs_a_second_person(
    pool: PgPool,
) {
    let w = world(&pool).await;
    correct_on(&pool, &w, w.in_a, json!({ "hire_date": "2024-03-02" }))
        .await
        .unwrap();
    let err = correct_on(
        &pool,
        &w,
        w.in_a,
        json!({ "group_service_start_date": "2024-03-03" }),
    )
    .await
    .unwrap_err();
    assert_eq!(
        err.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "after the 입사일"
    );
    let first = correct_on(
        &pool,
        &w,
        w.in_a,
        json!({ "group_service_start_date": "2019-01-02" }),
    )
    .await
    .unwrap();
    assert!(
        first.pending_request.is_none(),
        "a first recording applies at once"
    );

    let pending = correct_on(
        &pool,
        &w,
        w.in_a,
        json!({ "group_service_start_date": "2018-01-02" }),
    )
    .await
    .unwrap();
    let request = pending
        .pending_request
        .expect("a recorded 근속 기산일 changes by a second person");
    let facts = w.hr.personal_facts(w.hr(w.hr_one), w.in_a).await.unwrap();
    assert_eq!(
        facts.group_service_start_date.as_deref(),
        Some("2019-01-02")
    );
    w.hr.decide_change_request(w.hr(w.hr_two), request.id, decide("APPLY"), SECOND)
        .await
        .unwrap();
    let facts = w.hr.personal_facts(w.hr(w.hr_one), w.in_a).await.unwrap();
    assert_eq!(
        facts.group_service_start_date.as_deref(),
        Some("2018-01-02")
    );

    // Moving the 입사일 before the recorded 그룹 입사일 is refused at filing.
    let err = correct_on(&pool, &w, w.in_a, json!({ "hire_date": "2017-01-01" }))
        .await
        .unwrap_err();
    assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
}

fn bulk(dry_run: bool, rows: Value) -> BulkRegisterFactsRequest {
    serde_json::from_value(json!({ "dry_run": dry_run, "reason_code": "MIGRATION", "rows": rows }))
        .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_personal_profile_imports_in_bulk_and_takes_a_group_start_only_once(pool: PgPool) {
    let w = world(&pool).await;
    let rows = json!([
        { "employee_id": w.in_a, "changes": { "name_en": "KIM HANA", "nationality": "VN",
          "emergency_contacts": [{ "name": "이하나", "relation": "SIBLING", "phone": "010-2222-3333", "contact_notified": true }] } },
        { "employee_id": w.in_b, "changes": { "group_service_start_date": "2015-06-01", "name_hanja": "朴" } },
    ]);
    let plan =
        w.hr.bulk_correct_register_facts(w.hr(w.hr_one), bulk(true, rows.clone()))
            .await
            .unwrap();
    assert_eq!(
        plan.rows[0].changed,
        ["name_en", "nationality", "emergency_contacts"]
    );
    assert_eq!(
        plan.rows[1].changed,
        ["group_service_start_date", "name_hanja"]
    );
    assert!(
        ledger(&pool, w.in_a).await.is_empty(),
        "a dry run writes nothing"
    );
    let done =
        w.hr.bulk_correct_register_facts(w.hr(w.hr_one), bulk(false, rows))
            .await
            .unwrap();
    assert!(done.applied);
    assert_eq!(ledger(&pool, w.in_b).await.len(), 2);

    let again = json!([
        { "employee_id": w.in_b, "changes": { "group_service_start_date": "2014-01-01" } },
        { "employee_id": w.in_a, "changes": { "photo": Uuid::new_v4() } },
    ]);
    let plan =
        w.hr.bulk_correct_register_facts(w.hr(w.hr_one), bulk(true, again))
            .await
            .unwrap();
    assert!(
        plan.rows.iter().all(|row| row.error.is_some()),
        "a recorded 근속 기산일 and a 사진 are not bulk items"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn former_employee_cannot_issue_photo_upload(pool: PgPool) {
    let w = world(&pool).await;
    sqlx::query(
        "UPDATE employees SET employment_status='EXITED', exit_date='2026-10-10' WHERE id=$1",
    )
    .bind(w.in_a)
    .execute(&pool)
    .await
    .unwrap();
    let request =
        serde_json::from_value(json!({ "content_type": "image/jpeg", "byte_size": 1024 })).unwrap();
    let error =
        w.hr.issue_photo_upload(w.hr(w.hr_one), w.in_a, request)
            .await
            .unwrap_err();
    assert_eq!(
        (error.status.as_u16(), error.code),
        (409, "employee_exited_read_only")
    );
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM employee_photo_uploads WHERE employee_id=$1")
            .bind(w.in_a)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn former_employee_cannot_confirm_photo_upload_issued_while_active(pool: PgPool) {
    let w = world(&pool).await;
    let request =
        serde_json::from_value(json!({ "content_type": "image/jpeg", "byte_size": 1024 })).unwrap();
    let upload =
        w.hr.issue_photo_upload(w.hr(w.hr_one), w.in_a, request)
            .await
            .unwrap();
    assert!(!upload.confirmed);
    let id = upload.upload_id;
    sqlx::query(
        "UPDATE employees SET employment_status='EXITED', exit_date='2026-10-10' WHERE id=$1",
    )
    .bind(w.in_a)
    .execute(&pool)
    .await
    .unwrap();
    let error =
        w.hr.confirm_photo_upload(w.hr(w.hr_one), upload)
            .await
            .unwrap_err();
    assert_eq!(
        (error.status.as_u16(), error.code),
        (409, "employee_exited_read_only")
    );
    let confirmed: bool = sqlx::query_scalar(
        "SELECT confirmed_at IS NOT NULL FROM employee_photo_uploads WHERE id=$1",
    )
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!confirmed);
}
