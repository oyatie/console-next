#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! MR-23: the 근로자 명부 items through the MR-8 ledger, their read, the bulk
//! import profile and the register export, as the runtime role `console_rt`.

mod support;

use console_hr_adapter_postgres::HrError;
use console_hr_adapter_postgres::corrections::{CorrectEmployeeRequest, CorrectionOutcome};
use console_hr_adapter_postgres::directory::read_export::ExportPurposeQuery;
use console_hr_adapter_postgres::directory::read_list::EmployeeListQuery;
use console_hr_adapter_postgres::register_facts::bulk::BulkRegisterFactsRequest;
use console_platform_test_support::soft_passkey::passkey_service;
use futures::StreamExt;
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use support::{SECOND, World, decide, world};

async fn version(pool: &PgPool, employee: Uuid) -> String {
    let at: OffsetDateTime = sqlx::query_scalar("SELECT updated_at FROM employees WHERE id = $1")
        .bind(employee)
        .fetch_one(pool)
        .await
        .unwrap();
    at.format(&Rfc3339).unwrap()
}

async fn correct(
    w: &World,
    expected: String,
    changes: Value,
) -> Result<CorrectionOutcome, HrError> {
    let body: CorrectEmployeeRequest = serde_json::from_value(json!({
        "expected_updated_at": expected,
        "changes": changes,
        "reason_code": "DATA_ENTRY_ERROR",
    }))
    .unwrap();
    w.hr.correct_employee(w.hr(w.hr_one), &passkey_service(), w.in_a, body, SECOND)
        .await
}

async fn ledger(
    pool: &PgPool,
    employee: Uuid,
) -> Vec<(String, Option<Value>, Value, Option<Uuid>)> {
    sqlx::query_as(
        "SELECT field, old_value, new_value, change_request_id FROM employee_corrections \
         WHERE employee_id = $1 ORDER BY created_at, field",
    )
    .bind(employee)
    .fetch_all(pool)
    .await
    .unwrap()
}

fn address(road: &str) -> Value {
    json!({ "source": "MANUAL_UNVERIFIED", "road_addr_part1": road,
            "si_nm": "서울특별시", "sgg_nm": "강남구", "detail": "3층" })
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn register_items_are_corrected_with_a_ledger_and_kept_history(pool: PgPool) {
    let w = world(&pool).await;
    let careers = json!([{ "employer_name": "가나상사", "from": "2019-03", "to": "2021-12",
                           "position": "대리", "duty": "정비" }]);
    let done = correct(
        &w,
        version(&pool, w.in_a).await,
        json!({
            "sex": "FEMALE", "address": address("서울특별시 강남구 테헤란로 1"),
            "careers": careers, "register_note": "야간 근무 희망",
        }),
    )
    .await
    .unwrap();
    assert!(done.pending_request.is_none());
    let rows = ledger(&pool, w.in_a).await;
    assert_eq!(rows.len(), 4);
    assert!(
        rows.iter()
            .all(|(_, old, _, request)| old.is_none() && request.is_none()),
        "first recordings carry no old value"
    );

    // A second address is a new row; the 경력 list becomes 「경력 없음」.
    let stale = version(&pool, w.in_a).await;
    correct(
        &w,
        stale.clone(),
        json!({
            "address": address("서울특별시 강남구 테헤란로 2"), "careers": [],
        }),
    )
    .await
    .unwrap();
    let err = correct(&w, stale, json!({ "sex": "MALE" }))
        .await
        .unwrap_err();
    assert_eq!(
        err.status,
        StatusCode::CONFLICT,
        "a stale version is refused"
    );

    let facts = w.hr.register_facts(w.hr(w.hr_one), w.in_a).await.unwrap();
    assert_eq!(facts.sex.as_deref(), Some("FEMALE"));
    assert_eq!(
        facts.address["road_addr_part1"],
        "서울특별시 강남구 테헤란로 2"
    );
    assert_eq!(facts.careers, json!([]));
    assert_eq!(facts.register_note.as_deref(), Some("야간 근무 희망"));
    let kept: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM employee_addresses WHERE employee_id = $1), \
                (SELECT count(*) FROM employee_careers WHERE employee_id = $1 AND voided_at IS NOT NULL)",
    )
    .bind(w.in_a)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(kept, (2, 1), "the old address and career row stay");
    let last = ledger(&pool, w.in_a).await;
    let career = last.iter().rfind(|row| row.0 == "careers").unwrap();
    assert_eq!(career.1.as_ref().unwrap()[0]["employer_name"], "가나상사");
    assert_eq!(career.2, json!([]));

    // A branch-scoped reader cannot read the register items.
    let reader = w.admin(w.admin_a, w.branch_a);
    assert!(w.hr.register_facts(reader, w.in_a).await.is_err());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_exit_reason_is_recorded_once_then_changed_by_a_second_person(pool: PgPool) {
    let w = world(&pool).await;
    let change = |changes| async { correct(&w, version(&pool, w.in_a).await, changes).await };
    let err = change(json!({ "exit_reason": "CONTRACT_END" }))
        .await
        .unwrap_err();
    assert_eq!(
        (err.status, err.code),
        (StatusCode::CONFLICT, "employee_not_exited")
    );

    sqlx::query("UPDATE employees SET employment_status = 'EXITED' WHERE id = $1")
        .bind(w.in_a)
        .execute(&pool)
        .await
        .unwrap();
    // The first recording applies at once (MR-8 route_for_current).
    let first = change(json!({ "exit_reason": "CONTRACT_END" }))
        .await
        .unwrap();
    assert!(first.pending_request.is_none());
    let facts = w.hr.register_facts(w.hr(w.hr_one), w.in_a).await.unwrap();
    assert_eq!(facts.exit_reason_label.as_deref(), Some("계약만료"));

    // Changing a recorded 사유 is a second person's call.
    let pending = change(json!({ "exit_reason": "DISCIPLINARY_DISMISSAL" }))
        .await
        .unwrap();
    let request = pending.pending_request.expect("a high-risk change waits");
    let facts = w.hr.register_facts(w.hr(w.hr_one), w.in_a).await.unwrap();
    assert_eq!(facts.exit_reason_code.as_deref(), Some("CONTRACT_END"));
    w.hr.decide_change_request(w.hr(w.hr_two), request.id, decide("APPLY"), SECOND)
        .await
        .unwrap();
    let facts = w.hr.register_facts(w.hr(w.hr_one), w.in_a).await.unwrap();
    assert_eq!(facts.exit_reason_label.as_deref(), Some("징계해고"));
    let rows = ledger(&pool, w.in_a).await;
    let last = rows.last().unwrap();
    assert_eq!(
        (last.1.clone(), last.3),
        (Some(json!("CONTRACT_END")), Some(request.id))
    );
    assert!(
        change(json!({ "exit_reason": null })).await.is_err(),
        "never cleared"
    );
}

fn bulk(dry_run: bool, rows: Value) -> BulkRegisterFactsRequest {
    serde_json::from_value(json!({ "dry_run": dry_run, "reason_code": "MIGRATION", "rows": rows }))
        .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_import_profile_dry_runs_then_applies_all_or_nothing(pool: PgPool) {
    let w = world(&pool).await;
    sqlx::query(
        "UPDATE employees SET employee_number = 'E-' || left(id::text, 4) WHERE org_id = $1",
    )
    .bind(w.org)
    .execute(&pool)
    .await
    .unwrap();
    let number: String = sqlx::query_scalar("SELECT employee_number FROM employees WHERE id = $1")
        .bind(w.in_b)
        .fetch_one(&pool)
        .await
        .unwrap();
    let rows = json!([
        { "employee_number": number, "changes": { "sex": "MALE", "careers": [] } },
        { "employee_id": w.in_a, "changes": { "exit_reason": "DEATH" } },
    ]);
    let plan =
        w.hr.bulk_correct_register_facts(w.hr(w.hr_one), bulk(true, rows.clone()))
            .await
            .unwrap();
    assert_eq!(plan.rows[0].changed, ["sex", "careers"]);
    assert!(
        plan.rows[1].error.is_some(),
        "the 퇴직 사유 is not a bulk item"
    );
    let err =
        w.hr.bulk_correct_register_facts(w.hr(w.hr_one), bulk(false, rows))
            .await
            .unwrap_err();
    assert_eq!(err.code, "bulk_register_facts_refused");
    assert!(
        ledger(&pool, w.in_b).await.is_empty(),
        "nothing was recorded"
    );

    let changes = json!({ "address": address("서울특별시 강남구 테헤란로 9"), "careers": [] });
    let rows = json!([{ "employee_number": number, "changes": changes }]);
    let done =
        w.hr.bulk_correct_register_facts(w.hr(w.hr_one), bulk(false, rows.clone()))
            .await
            .unwrap();
    assert!(done.applied);
    assert_eq!(ledger(&pool, w.in_b).await.len(), 2);
    let again =
        w.hr.bulk_correct_register_facts(w.hr(w.hr_one), bulk(false, rows))
            .await
            .unwrap();
    assert!(
        again.rows[0].changed.is_empty(),
        "an unchanged value writes no ledger row"
    );
    assert_eq!(ledger(&pool, w.in_b).await.len(), 2);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_register_export_prints_the_items_as_labels(pool: PgPool) {
    let w = world(&pool).await;
    sqlx::query(
        "UPDATE employees SET employment_status = 'EXITED', employee_number = 'E-1' WHERE id = $1",
    )
    .bind(w.in_a)
    .execute(&pool)
    .await
    .unwrap();
    correct(&w, version(&pool, w.in_a).await, json!({
        "sex": "FEMALE", "address": address("서울특별시 강남구 테헤란로 1"),
        "careers": [{ "employer_name": "가나상사", "from": "2019-03", "to": "2021-12", "duty": "정비" }],
        "register_note": "비고",
    }))
    .await
    .unwrap();
    correct(
        &w,
        version(&pool, w.in_a).await,
        json!({ "exit_reason": "CONTRACT_END" }),
    )
    .await
    .unwrap();
    let query: EmployeeListQuery =
        serde_json::from_value(json!({ "employee_number": "E-1" })).unwrap();
    let (_, chunks) =
        w.hr.export_employees_csv(
            w.hr(w.hr_one),
            query,
            ExportPurposeQuery {
                export_purpose: Some("AUDIT_RESPONSE".to_owned()),
                layout: Some("register".to_owned()),
            },
        )
        .await
        .unwrap();
    let body = chunks
        .map(|chunk| chunk.unwrap())
        .collect::<Vec<_>>()
        .await
        .concat();
    let row = body.trim_end().split("\r\n").nth(1).unwrap().to_owned();
    assert!(
        row.starts_with("E-1,E,여,,\"서울특별시 강남구 테헤란로 1, 3층\","),
        "{row}"
    );
    assert!(
        row.ends_with(",계약만료,가나상사 2019-03~2021-12 정비,비고"),
        "{row}"
    );
}
