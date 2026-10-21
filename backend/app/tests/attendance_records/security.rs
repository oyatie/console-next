//! All eight S2 routes: live foreign targets, lower grants, unchanged DB state and refusal audit.

use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[path = "../support/http.rs"]
mod http_support;
use http_support::{Ctx, add_user, ctx, employee_body, structure, tenant};

#[path = "../../../crates/attendance/adapter-postgres/tests/records/security_support.rs"]
mod record_state;
use record_state::business;

async fn denied_audits(pool: &PgPool, actor: Uuid, code: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE actor=$1 AND outcome='DENIED' AND after_snap->>'refusal_code'=$2")
        .bind(actor).bind(code).fetch_one(pool).await.unwrap()
}

async fn refused(
    pool: &PgPool,
    caller: &Ctx,
    method: &str,
    path: &str,
    input: Option<Value>,
    expected: (StatusCode, &str),
) {
    let (status, code) = expected;
    let before = business(pool).await;
    let audits = denied_audits(pool, *caller.user.as_uuid(), code).await;
    let (got, body) = caller.call(method, path, input).await;
    assert_eq!(got, status, "{method} {path}: {body}");
    if status == StatusCode::OK {
        assert_eq!(body["cells"][0]["status"], "REFUSED");
        assert_eq!(body["cells"][0]["code"], code);
        assert!(body["cells"][0]["after"].is_null());
    } else {
        assert_eq!(body["error"]["code"], code, "{method} {path}: {body}");
    }
    assert_eq!(
        business(pool).await,
        before,
        "{method} {path} changed records"
    );
    assert_eq!(
        denied_audits(pool, *caller.user.as_uuid(), code).await,
        audits + 1,
        "{method} {path} lacks refusal audit"
    );
    assert!(
        !body.to_string().contains("직원S2-"),
        "foreign/scoped employee name leaked"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn all_record_routes_refuse_different_tenant_and_lower_grant_with_audit(pool: PgPool) {
    let (home, owner) = tenant(&pool, &["SUPER_ADMIN"]).await;
    let admin = ctx(&pool, home, owner, &["SUPER_ADMIN"], None).await;
    let (entity, workplace, branch, unit) = structure(&admin).await;
    let mut people = Vec::new();
    for number in ["S2-1", "S2-2"] {
        let (status, hired) = admin
            .call(
                "POST",
                "/api/v1/employees",
                Some(employee_body(number, &branch, &unit)),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{hired}");
        people.push(hired["employee"]["id"].as_str().unwrap().to_owned());
        let (status, bound) = admin.call("POST", "/api/v1/employment-assignments", Some(json!({"employee_id":hired["employee"]["id"], "legal_entity_id":entity, "workplace_id":workplace, "valid_from":"2026-01-02"}))).await;
        assert_eq!(status, StatusCode::CREATED, "{bound}");
    }
    let low = add_user(&pool, home, &["MEMBER"]).await;
    let lower = ctx(&pool, home, low, &["MEMBER"], None).await;
    let (org, actor) = tenant(&pool, &["SUPER_ADMIN"]).await;
    let foreign = ctx(&pool, org, actor, &["SUPER_ADMIN"], None).await;
    let date = "2026-10-06";
    let cell = json!({"employee_id":people[0], "work_date":date, "value":"9-18"});
    let save = json!({"cells":[cell], "source":"MANUAL", "evidence":{"kind":"PAPER_SHEET"}});
    let (status, receipt) = admin
        .call("POST", "/api/v1/attendance/entries", Some(save.clone()))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{receipt}");
    let batch = receipt["batch_id"].as_str().unwrap();
    let entry: Uuid = sqlx::query_scalar("SELECT id FROM attendance_entries WHERE batch_id=$1")
        .bind(Uuid::parse_str(batch).unwrap())
        .fetch_one(&pool)
        .await
        .unwrap();
    let write_cell = json!({"employee_id":people[1], "work_date":date, "value":"9-18"});
    let cases = [
        (
            "GET",
            format!(
                "/api/v1/attendance/days?date={date}&workplace_id={}",
                workplace
            ),
            None,
            StatusCode::NOT_FOUND,
            "scope_not_found",
        ),
        (
            "GET",
            format!(
                "/api/v1/attendance/month?month=2026-10&workplace_id={}",
                workplace
            ),
            None,
            StatusCode::NOT_FOUND,
            "scope_not_found",
        ),
        (
            "GET",
            format!(
                "/api/v1/attendance/people/{}/month?month=2026-10",
                people[0]
            ),
            None,
            StatusCode::NOT_FOUND,
            "scope_not_found",
        ),
        (
            "POST",
            "/api/v1/attendance/entries/preview".into(),
            Some(json!({"cells":[write_cell]})),
            StatusCode::OK,
            "not_on_roster",
        ),
        (
            "POST",
            "/api/v1/attendance/entries".into(),
            Some(json!({"cells":[write_cell],"source":"MANUAL","evidence":{"kind":"PAPER_SHEET"}})),
            StatusCode::UNPROCESSABLE_ENTITY,
            "cells_refused",
        ),
        (
            "POST",
            format!("/api/v1/attendance/batches/{batch}/undo"),
            Some(json!({"reason":"scope test"})),
            StatusCode::NOT_FOUND,
            "batch_not_found",
        ),
        (
            "POST",
            format!("/api/v1/attendance/entries/{entry}/correct"),
            Some(json!({"value":"9-17","reason":"scope test","evidence":{"kind":"PAPER_SHEET"}})),
            StatusCode::NOT_FOUND,
            "entry_not_found",
        ),
        (
            "POST",
            format!("/api/v1/attendance/entries/{entry}/void"),
            Some(json!({"reason":"scope test","evidence":{"kind":"PAPER_SHEET"}})),
            StatusCode::NOT_FOUND,
            "entry_not_found",
        ),
    ];
    for (method, path, input, status, code) in cases {
        refused(
            &pool,
            &lower,
            method,
            &path,
            input.clone(),
            (StatusCode::FORBIDDEN, "forbidden"),
        )
        .await;
        refused(&pool, &foreign, method, &path, input, (status, code)).await;
    }
    // Whole-tenant reads still expose only the signed tenant's rows.
    let (_, month) = foreign
        .call("GET", "/api/v1/attendance/month?month=2026-10", None)
        .await;
    assert_eq!(month["rows"], json!([]));
    let (_, board) = foreign
        .call("GET", "/api/v1/attendance/days?date=2026-10-06", None)
        .await;
    assert_eq!(board["groups"], json!([]));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_record_read_refusal_fails_closed_when_its_audit_cannot_be_written(pool: PgPool) {
    let (org, user) = tenant(&pool, &["MEMBER"]).await;
    let lower = ctx(&pool, org, user, &["MEMBER"], None).await;
    let before = business(&pool).await;
    sqlx::query("REVOKE INSERT ON audit_events FROM console_rt")
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = lower
        .call("GET", "/api/v1/attendance/days?date=2026-10-06", None)
        .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(body["error"]["code"], "unavailable");
    assert_eq!(business(&pool).await, before);
    assert_eq!(denied_audits(&pool, *user.as_uuid(), "forbidden").await, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn native_record_path_validation_keeps_its_refusal_status_and_code(pool: PgPool) {
    let (org, user) = tenant(&pool, &["SUPER_ADMIN"]).await;
    let admin = ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    let before = business(&pool).await;
    let (status, body) = admin
        .call(
            "GET",
            "/api/v1/attendance/people/not-a-uuid/month?month=2026-10",
            None,
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["code"], "bad_request");
    assert_eq!(business(&pool).await, before);
    assert_eq!(
        denied_audits(&pool, *user.as_uuid(), "bad_request").await,
        1
    );
}

#[path = "unknown_fields.rs"]
mod unknown_fields;

#[path = "schedule_unknown_fields.rs"]
mod schedule_unknown_fields;
