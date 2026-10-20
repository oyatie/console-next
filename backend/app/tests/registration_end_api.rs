// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! HTTP regression: an unused certificate can be voided even when its entity is in use.

#[path = "support/http.rs"]
mod support;

use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn registration_preview_uses_its_own_links_before_void(owner: PgPool) {
    let (org, user) = support::tenant(&owner, &["SUPER_ADMIN"]).await;
    let ctx = support::ctx(&owner, org, user, &["SUPER_ADMIN"], None).await;
    let (entity, _, branch, unit) = support::structure(&ctx).await;
    let (status, employee) = ctx
        .call(
            "POST",
            "/api/v1/employees",
            Some(support::employee_body("REG-1", &branch, &unit)),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{employee}");
    let (status, end) = ctx
        .call(
            "GET",
            &format!("/api/v1/legal-entities/{entity}/end-options"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{end}");
    assert_eq!(end["delete"]["refusal"], "record_in_use");
    let uri = format!("/api/v1/legal-entities/{entity}");
    let (status, read) = ctx.call("GET", &uri, None).await;
    assert_eq!(status, StatusCode::OK, "{read}");
    let mut declare = support::entity_body();
    declare["vat_unit_mode"] = json!("PER_WORKPLACE");
    declare["expected_version"] = read["current"]["version"].clone();
    declare["effective_from"] = json!(support::today_kst());
    declare["reason_code"] = json!("CORRECTION");
    let (status, declared) = ctx.call("PUT", &uri, Some(declare)).await;
    assert_eq!(status, StatusCode::OK, "{declared}");
    let (status, spare) = ctx
        .call(
            "POST",
            &format!("/api/v1/legal-entities/{entity}/registrations"),
            Some(json!({
                "brn": "000-81-00071", "opened_on": "2020-03-02",
                "business_address": support::address(), "unit_taxation": false,
                "tax_office_label": "삼성세무서", "tax_type": "01",
                "business_types": [{ "is_main": true, "sector": "정보통신업", "item": "소프트웨어" }],
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{spare}");
    let id = spare["record"]["id"].as_str().unwrap();
    let path = format!("/api/v1/business-registrations/{id}");
    let (status, end) = ctx.call("GET", &format!("{path}/end-options"), None).await;
    assert_eq!(status, StatusCode::OK, "{end}");
    assert_eq!(end["id"], id);
    assert_eq!(end["delete"], json!({ "allowed": true }));
    assert_eq!(end["can_manage"], true);
    assert_eq!(end["revisions"], 1);
    assert_eq!(end["linked_workplaces"], json!([]));
    let (status, result) = ctx
        .call(
            "POST",
            &format!("{path}/void"),
            Some(json!({ "reason_code": "DUPLICATE" })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{result}");
    let (status, _) = ctx.call("GET", &format!("{path}/end-options"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
