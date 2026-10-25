// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Exit guards, localization, correlation and authorization at the HTTP boundary.
#[path = "support/go_live.rs"]
mod go_live;
#[path = "support/http.rs"]
mod http_support;
use axum::body::{Body, to_bytes};
use http::{Request, StatusCode};
use http_support::{Ctx, ctx, employee_body, structure, tenant};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;
fn acks() -> Value {
    json!({"privacy_notice_ack":true,"korean_labor_law_ack":true,"payroll_cutoff_ack":true,"retirement_settlement_ack":true})
}
async fn ko(c: &Ctx, method: &str, path: &str, body: Value) -> (u16, Value) {
    let response = c
        .service
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("Authorization", format!("Bearer {}", c.token))
                .header("Content-Type", "application/json")
                .header("Accept-Language", "ko")
                .header("Idempotency-Key", Uuid::new_v4().to_string())
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let v =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    (status, v)
}
async fn fixture(pool: &PgPool) -> (Ctx, String) {
    let (org, user) = tenant(pool, &["SUPER_ADMIN"]).await;
    let c = ctx(pool, org, user, &["SUPER_ADMIN"], None).await;
    let (_, _, branch, unit) = structure(&c).await;
    let mut body = employee_body("EG-1", &branch, &unit);
    // The fixed October exits need their original service period for notice guards.
    body["hire_date"] = json!("2026-01-02");
    let (s, e) = c.call("POST", "/api/v1/employees", Some(body)).await;
    assert_eq!(s, StatusCode::CREATED, "{e}");
    go_live::go_live(pool, org).await;
    (c, e["employee"]["id"].as_str().unwrap().into())
}
async fn report(c: &Ctx, id: &str, reason: Option<&str>) -> Value {
    let (s,v)=ko(c,"POST","/api/v1/hr/exit-cases",json!({"employee_id":id,"effective_exit_date":"2026-10-10","site_manager_note":"합성 퇴직 경위","exit_reason_code":reason})).await;
    assert_eq!(s, 201, "{v}");
    v
}
fn refusal(s: u16, v: &Value, status: u16, code: &str, korean: &str) {
    assert_eq!(
        (s, v["error"]["code"].as_str().unwrap()),
        (status, code),
        "{v}"
    );
    assert!(
        v["error"]["message"].as_str().unwrap().contains(korean),
        "{v}"
    );
    assert!(
        v["error"]["operation_id"].as_str().is_some(),
        "correlated support reference: {v}"
    );
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn protected_report_reaches_the_wire_in_korean_and_writes_nothing(pool: PgPool) {
    let (c, id) = fixture(&pool).await;
    let (s,l)=ko(&c,"POST",&format!("/api/v1/employees/{id}/lifecycle-events"),json!({"event_type":"LEAVE_OF_ABSENCE","leave_type":"WORK_INJURY","effective_date":"2026-10-09","comment":"합성 요양","signoffs":acks()})).await;
    assert_eq!(s, 200, "{l}");
    let (s,v)=ko(&c,"POST","/api/v1/hr/exit-cases",json!({"employee_id":id,"effective_exit_date":"2026-10-10","site_manager_note":"합성","exit_reason_code":"DISCIPLINARY_DISMISSAL"})).await;
    refusal(s, &v, 409, "exit_protected_period", "보호기간");
    assert_eq!(v["error"]["refusals"][0]["lifecycle_event_id"], l["id"]);
    assert_eq!(
        http_support::count(&pool, "employee_exit_cases", c.org).await,
        0
    );
    assert_eq!(
        http_support::audits(&pool, c.org, "employee.exit.report").await,
        0
    );
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn reason_and_written_notice_are_required_on_confirmation(pool: PgPool) {
    let (c, id) = fixture(&pool).await;
    let case = report(&c, &id, None).await;
    let path = format!(
        "/api/v1/hr/exit-cases/{}/confirm",
        case["id"].as_str().unwrap()
    );
    let (s, v) = ko(&c, "POST", &path, json!({"signoffs":acks()})).await;
    refusal(s, &v, 422, "exit_reason_required", "퇴직 사유");
    assert_eq!(v["error"]["refusals"][0]["field"], "exit_reason_code");
    let (s, v) = ko(
        &c,
        "POST",
        &path,
        json!({"exit_reason_code":"DISCIPLINARY_DISMISSAL","signoffs":acks()}),
    )
    .await;
    refusal(s, &v, 422, "notice_evidence_missing", "서면 통지");
    assert_eq!(
        v["error"]["refusals"][0]["missing"],
        json!(["reason_text", "served_on", "method", "evidence_ref"])
    );
    let (s,v)=ko(&c,"POST",&path,json!({"notice_disposition":{"kind":"PAY_IN_LIEU"},"exit_reason_code":"DISCIPLINARY_DISMISSAL","signoffs":acks(),"dismissal_notice":{"reason_text":"합성 사유","served_on":" ","method":" ","evidence_ref":"synthetic"}})).await;
    refusal(s, &v, 422, "notice_evidence_missing", "서면 통지");
    assert_eq!(
        v["error"]["refusals"][0]["missing"],
        json!(["served_on", "method"])
    );
    assert_eq!(
        http_support::audits(&pool, c.org, "employee.exit.confirm").await,
        0
    );
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn reason_catalog_exposes_class_and_refuses_an_invalid_class(pool: PgPool) {
    let (c, _) = fixture(&pool).await;
    let (s, v) = c
        .call("GET", "/api/v1/reason-codes?domain=exit_reason", None)
        .await;
    assert_eq!(s, StatusCode::OK);
    let rows = v["items"].as_array().unwrap();
    let find = |code| rows.iter().find(|r| r["code"] == code).unwrap();
    assert_eq!(find("DISCIPLINARY_DISMISSAL")["notice_required"], true);
    assert_eq!(find("ADVISED_RESIGNATION_FAULT")["involuntary"], true);
    assert_eq!(find("PERSONAL")["involuntary"], false);
    let (s,v)=ko(&c,"POST","/api/v1/reason-codes",json!({"domain":"lifecycle_transfer","label_ko":"합성","requires_note":false,"involuntary":true})).await;
    refusal(s, &v, 422, "reason_class_invalid", "퇴직 사유");
    assert_eq!(http_support::count(&pool, "reason_codes", c.org).await, 0);
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_valid_notice_does_not_bypass_grants_or_tenant_boundaries(pool: PgPool) {
    let (c, id) = fixture(&pool).await;
    let case = report(&c, &id, Some("DISCIPLINARY_DISMISSAL")).await;
    let path = format!(
        "/api/v1/hr/exit-cases/{}/confirm",
        case["id"].as_str().unwrap()
    );
    let valid = json!({"signoffs":acks(),"dismissal_notice":{"reason_text":"합성 사유","served_on":"2026-10-10","method":"CERTIFIED_MAIL","evidence_ref":"synthetic"}});
    let lower_user = http_support::add_user(&pool, c.org, &["MEMBER"]).await;
    let lower = ctx(&pool, c.org, lower_user, &["MEMBER"], None).await;
    let before = http_support::count(&pool, "employee_lifecycle_events", c.org).await;
    let (s, v) = ko(&lower, "POST", &path, valid.clone()).await;
    assert_eq!(s, 403, "{v}");
    let (other_org, other_user) = tenant(&pool, &["SUPER_ADMIN"]).await;
    go_live::go_live(&pool, other_org).await;
    let other = ctx(&pool, other_org, other_user, &["SUPER_ADMIN"], None).await;
    let (s, v) = ko(&other, "POST", &path, valid).await;
    assert_eq!(s, 404, "{v}");
    assert_eq!(
        http_support::count(&pool, "employee_lifecycle_events", c.org).await,
        before
    );
    assert_eq!(
        http_support::audits(&pool, c.org, "employee.exit.confirm").await,
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT status FROM employee_exit_cases WHERE id=$1")
            .bind(case["id"].as_str().unwrap().parse::<Uuid>().unwrap())
            .fetch_one(&pool)
            .await
            .unwrap(),
        "REPORTED"
    );
}
