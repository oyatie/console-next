//! Each S2 command body refuses a field it does not know: 422 `body_invalid`, nothing written.

use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use super::http_support::{ctx, employee_body, structure, tenant};
use super::record_state::business;

fn with_unknown(mut body: Value) -> Value {
    body["unexpected"] = json!(true);
    body
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn every_record_command_refuses_an_unknown_field_and_writes_nothing(pool: PgPool) {
    let (org, owner) = tenant(&pool, &["SUPER_ADMIN"]).await;
    let admin = ctx(&pool, org, owner, &["SUPER_ADMIN"], None).await;
    let (entity, workplace, branch, unit) = structure(&admin).await;
    let mut body = employee_body("S2-U1", &branch, &unit);
    body["hire_date"] = json!("2026-01-02");
    let (status, hired) = admin.call("POST", "/api/v1/employees", Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "{hired}");
    let person = hired["employee"]["id"].clone();
    let (status, bound) = admin.call("POST", "/api/v1/employment-assignments", Some(json!({"employee_id":person, "legal_entity_id":entity, "workplace_id":workplace, "valid_from":"2026-01-02"}))).await;
    assert_eq!(status, StatusCode::CREATED, "{bound}");
    let cells = json!([{"employee_id":person, "work_date":"2026-10-06", "value":"9-18"}]);
    let evidence = json!({"kind":"PAPER_SHEET"});
    let save = json!({"cells":cells, "source":"MANUAL", "evidence":evidence});
    let (status, receipt) = admin
        .call("POST", "/api/v1/attendance/entries", Some(save.clone()))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{receipt}");
    let batch = receipt["batch_id"].as_str().unwrap().to_owned();
    let entry: Uuid = sqlx::query_scalar("SELECT id FROM attendance_entries WHERE batch_id=$1")
        .bind(Uuid::parse_str(&batch).unwrap())
        .fetch_one(&pool)
        .await
        .unwrap();
    let cases = [
        (
            "/api/v1/attendance/entries/preview".to_owned(),
            json!({"cells":cells}),
        ),
        ("/api/v1/attendance/entries".to_owned(), save),
        (
            format!("/api/v1/attendance/batches/{batch}/undo"),
            json!({"reason":"unknown field test"}),
        ),
        (
            format!("/api/v1/attendance/entries/{entry}/correct"),
            json!({"value":"9-17", "reason":"unknown field test", "evidence":evidence}),
        ),
        (
            format!("/api/v1/attendance/entries/{entry}/void"),
            json!({"reason":"unknown field test", "evidence":evidence}),
        ),
    ];
    for (path, body) in cases {
        let before = business(&pool).await;
        let (status, refused) = admin.call("POST", &path, Some(with_unknown(body))).await;
        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{path}: {refused}"
        );
        assert_eq!(
            refused["error"]["code"], "body_invalid",
            "{path}: {refused}"
        );
        assert_eq!(business(&pool).await, before, "{path} changed records");
    }
}
