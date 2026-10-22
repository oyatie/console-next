// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;
#[path = "support/refusals.rs"]
mod refusals;
#[path = "support/http.rs"]
mod support;
use support::{Ctx, add_user, ctx, tenant};
const ADMIN: &[&str] = &["SUPER_ADMIN"];

fn entity(name: &str) -> Value {
    json!({ "biz_kind": "INDIVIDUAL", "name": name, "representatives": ["홍길동"], "representation_mode": "SINGLE" })
}
fn individual_certificate() -> Value {
    json!({ "brn": "000-01-00007", "opened_on": "2020-03-02", "business_address": support::address(),
        "business_types": [{ "is_main": true, "sector": "정보통신업", "item": "소프트웨어 개발" }],
        "unit_taxation": false, "tax_office_label": "삼성세무서", "tax_type": "01" })
}
async fn setup(pool: &PgPool) -> (Ctx, String) {
    let (org, user) = tenant(pool, ADMIN).await;
    let c = ctx(pool, org, user, ADMIN, None).await;
    let (status, body) = c
        .call("POST", "/api/v1/legal-entities", Some(entity("가나상회")))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    (c, body["record"]["id"].as_str().unwrap().into())
}
async fn read(c: &Ctx, id: &str) -> Value {
    let (status, body) = c
        .call("GET", &format!("/api/v1/legal-entities/{id}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}
async fn revisions(pool: &PgPool, org: Uuid) -> i64 {
    support::count(pool, "business_registration_revisions", org).await
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn individual_create_validates_printed_trade_name_without_writes(pool: PgPool) {
    let (c, id) = setup(&pool).await;
    let uri = format!("/api/v1/legal-entities/{id}/registrations");
    for (name, code) in [
        ("  ".to_owned(), "required"),
        ("한".repeat(201), "too_long"),
    ] {
        let mut body = individual_certificate();
        body["trade_name"] = name.into();
        let before = revisions(&pool, c.org).await;
        let (status, problem) = c.call("POST", &uri, Some(body)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{problem}");
        assert!(
            refusals::field_codes(&problem).contains(&("trade_name".into(), code.into())),
            "{problem}"
        );
        assert_eq!(revisions(&pool, c.org).await, before);
        assert_eq!(
            support::count(&pool, "business_registrations", c.org).await,
            0
        );
    }
    let mut body = individual_certificate();
    body["trade_name"] = "가나상회 2호점".into();
    let (status, saved) = c.call("POST", &uri, Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "{saved}");
    assert_eq!(
        read(&c, &id).await["registrations"][0]["current"]["trade_name"],
        "가나상회 2호점"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn entity_rename_and_unrelated_revision_preserve_trade_name(pool: PgPool) {
    let (c, id) = setup(&pool).await;
    let mut body = individual_certificate();
    body["trade_name"] = "가나상회 2호점".into();
    let (status, saved) = c
        .call(
            "POST",
            &format!("/api/v1/legal-entities/{id}/registrations"),
            Some(body),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{saved}");
    let e = read(&c, &id).await;
    let mut rename = entity("가나상회 본점");
    rename["expected_version"] = e["current"]["version"].clone();
    rename["effective_from"] = e["current"]["effective_from"].clone();
    rename["reason_code"] = "CORRECTION".into();
    let (status, saved) = c
        .call("PUT", &format!("/api/v1/legal-entities/{id}"), Some(rename))
        .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let e = read(&c, &id).await;
    let r = &e["registrations"][0];
    assert_eq!(r["current"]["trade_name"], "가나상회 2호점");
    let uri = format!(
        "/api/v1/business-registrations/{}",
        r["id"].as_str().unwrap()
    );
    let mut body = individual_certificate();
    body["expected_version"] = r["current"]["version"].clone();
    body["effective_from"] = r["current"]["effective_from"].clone();
    body["reason_code"] = "CORRECTION".into();
    body["status"] = "CONTINUING".into();
    body["tax_office_label"] = "역삼세무서".into();
    let (status, saved) = c.call("PUT", &uri, Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(
        read(&c, &id).await["registrations"][0]["current"]["trade_name"],
        "가나상회 2호점"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn trade_name_revision_requires_own_tenant_manager_and_writes_nothing_when_refused(
    pool: PgPool,
) {
    let (c, id) = setup(&pool).await;
    let (status, saved) = c
        .call(
            "POST",
            &format!("/api/v1/legal-entities/{id}/registrations"),
            Some(individual_certificate()),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{saved}");
    let e = read(&c, &id).await;
    let r = &e["registrations"][0];
    let uri = format!(
        "/api/v1/business-registrations/{}",
        r["id"].as_str().unwrap()
    );
    let mut body = individual_certificate();
    body["trade_name"] = "상호 정정".into();
    body["expected_version"] = r["current"]["version"].clone();
    body["effective_from"] = r["current"]["effective_from"].clone();
    body["reason_code"] = "CORRECTION".into();
    body["status"] = "CONTINUING".into();
    let lower_user = add_user(&pool, c.org, &["MEMBER"]).await;
    let lower = ctx(&pool, c.org, lower_user, &["MEMBER"], None).await;
    let (org, user) = tenant(&pool, ADMIN).await;
    let other = ctx(&pool, org, user, ADMIN, None).await;
    let before = refusals::business_state(&pool, c.org).await;
    for (caller, status) in [
        (&lower, StatusCode::FORBIDDEN),
        (&other, StatusCode::NOT_FOUND),
    ] {
        refusals::refused(
            &pool,
            caller,
            "PUT",
            &uri,
            Some(body.clone()),
            status,
            if status == StatusCode::FORBIDDEN {
                "forbidden"
            } else {
                "registration_not_found"
            },
        )
        .await;
        assert_eq!(refusals::business_state(&pool, c.org).await, before);
    }
    let (status, saved) = c.call("PUT", &uri, Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(
        read(&c, &id).await["registrations"][0]["current"]["trade_name"],
        "상호 정정"
    );
}
