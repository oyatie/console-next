// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Integration tests for voiding a business registration (REG-c-crud-g13).
//!
//! Verifies:
//! - Voiding an unused registration marks it voided (204 No Content, voided_at set, voided: true).
//! - Replay handling accepts standard platform idempotency (204 or 409 command_applied).
//! - Authorization / scope checks: unauthorized callers receive 403.
//! - Cross-tenant requests are denied (404/403).
//! - Refuses void when registration is in-use by workplaces (409 record_in_use with remedy move_workplaces_first).
//! - Refuses void outside setup phase (409 phase_not_setup with remedy close_record_instead).

use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[path = "support/go_live.rs"]
mod go_live;
use go_live::go_live;

#[path = "support/http.rs"]
mod support;
use support::{Ctx, add_user, address, count, ctx, entity_body, structure, tenant};

#[path = "support/refusals.rs"]
mod refusals;
use refusals::{code, refused};

const ADMIN: &[&str] = &["SUPER_ADMIN"];
const VALID_BRN: &str = "000-81-00014";

fn registration_body(brn: &str) -> Value {
    json!({
        "brn": brn,
        "trade_name": "주식회사 가나 물류",
        "opened_on": "2021-01-04",
        "business_address": address(),
        "unit_taxation": false,
        "tax_office_label": "삼성세무서",
        "tax_type": "01",
        "business_types": [{ "is_main": true, "sector": "운수업", "item": "물류" }],
    })
}

/// Voiding an unused registration marks it voided (204 No Content, voided_at set);
/// an idempotent replay returns 204 or 409 command_applied.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn void_registration_marks_it_voided_and_idempotent_replay(pool: PgPool) {
    let (org, owner) = tenant(&pool, ADMIN).await;
    let ctx = ctx(&pool, org, owner, ADMIN, None).await;

    let (status, entity) = ctx
        .call("POST", "/api/v1/legal-entities", Some(entity_body()))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{entity}");
    let entity_id = entity["record"]["id"].as_str().unwrap();

    let (status, reg) = ctx
        .call(
            "POST",
            &format!("/api/v1/legal-entities/{entity_id}/registrations"),
            Some(registration_body(VALID_BRN)),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{reg}");
    let reg_id = reg["record"]["id"].as_str().unwrap();

    let (status, body) = ctx
        .call(
            "POST",
            &format!("/api/v1/business-registrations/{reg_id}/void"),
            Some(json!({ "reason_code": "MISTAKE" })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{status} {body}");

    let (voided_at, void_reason): (Option<time::OffsetDateTime>, Option<String>) = sqlx::query_as(
        "SELECT voided_at, void_reason_code FROM business_registrations WHERE id = $1",
    )
    .bind(Uuid::parse_str(reg_id).unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(voided_at.is_some(), "voided_at must be populated");
    assert_eq!(void_reason.as_deref(), Some("MISTAKE"));

    // Verify replay with identical idempotency key is accepted per platform idempotency
    let (status, body) = ctx
        .retry(
            "POST",
            &format!("/api/v1/business-registrations/{reg_id}/void"),
            Some(json!({ "reason_code": "MISTAKE" })),
        )
        .await;
    assert!(
        status == StatusCode::NO_CONTENT
            || (status == StatusCode::CONFLICT && code(&body) == "command_applied"),
        "replay must be 204 or 409 command_applied: {status} {body}"
    );

    // With a fresh idempotency key, subsequent void returns 404 (already voided)
    let (status, body) = ctx
        .call(
            "POST",
            &format!("/api/v1/business-registrations/{reg_id}/void"),
            Some(json!({ "reason_code": "MISTAKE" })),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{status} {body}");
    assert_eq!(code(&body), "registration_not_found");
}

/// Unauthorized callers receive 403, anonymous callers receive 401,
/// and cross-tenant callers receive 404/403.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn void_registration_authorization_and_cross_tenant_checks(pool: PgPool) {
    let (org_a, owner_a) = tenant(&pool, ADMIN).await;
    let ctx_a = ctx(&pool, org_a, owner_a, ADMIN, None).await;

    let (status, entity) = ctx_a
        .call("POST", "/api/v1/legal-entities", Some(entity_body()))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{entity}");
    let entity_id = entity["record"]["id"].as_str().unwrap();

    let (status, reg) = ctx_a
        .call(
            "POST",
            &format!("/api/v1/legal-entities/{entity_id}/registrations"),
            Some(registration_body(VALID_BRN)),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{reg}");
    let reg_id = reg["record"]["id"].as_str().unwrap();

    // Caller with MEMBER role receives 403
    let member = add_user(&pool, org_a, &["MEMBER"]).await;
    let member_ctx = ctx(&pool, org_a, member, &["MEMBER"], None).await;
    refused(
        &pool,
        &member_ctx,
        "POST",
        &format!("/api/v1/business-registrations/{reg_id}/void"),
        Some(json!({ "reason_code": "MISTAKE" })),
        StatusCode::FORBIDDEN,
        "forbidden",
    )
    .await;

    // Anonymous caller receives 401
    let anonymous = Ctx {
        token: "invalid-token".into(),
        ..ctx(&pool, org_a, owner_a, ADMIN, None).await
    };
    let (status, _) = anonymous
        .call(
            "POST",
            &format!("/api/v1/business-registrations/{reg_id}/void"),
            Some(json!({ "reason_code": "MISTAKE" })),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Cross-tenant caller from tenant B receives 404 or 403
    let (org_b, owner_b) = tenant(&pool, ADMIN).await;
    let ctx_b = ctx(&pool, org_b, owner_b, ADMIN, None).await;
    let (status, body) = ctx_b
        .call(
            "POST",
            &format!("/api/v1/business-registrations/{reg_id}/void"),
            Some(json!({ "reason_code": "MISTAKE" })),
        )
        .await;
    assert!(
        status == StatusCode::NOT_FOUND || status == StatusCode::FORBIDDEN,
        "cross-tenant must be 404 or 403: {status} {body}"
    );

    // Ensure registration in tenant A remains active and not voided
    let voided_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM business_registrations WHERE id = $1 AND voided_at IS NOT NULL",
    )
    .bind(Uuid::parse_str(reg_id).unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(voided_count, 0, "registration must remain unvoided");
}

/// A registration that has an active workplace filing under it refuses void
/// with 409 Conflict (code: record_in_use, remedy: move_workplaces_first).
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn void_registration_refuses_when_in_use_by_workplace(pool: PgPool) {
    let (org, owner) = tenant(&pool, ADMIN).await;
    let ctx = ctx(&pool, org, owner, ADMIN, None).await;

    let (_entity_id, wp_id, ..) = structure(&ctx).await;

    let reg_id: Uuid = sqlx::query_scalar("SELECT registration_id FROM workplaces WHERE id = $1")
        .bind(Uuid::parse_str(&wp_id).unwrap())
        .fetch_one(&pool)
        .await
        .unwrap();

    let before_voided = count(&pool, "business_registrations", org).await;

    let (status, body) = ctx
        .call(
            "POST",
            &format!("/api/v1/business-registrations/{reg_id}/void"),
            Some(json!({ "reason_code": "MISTAKE" })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{status} {body}");
    assert_eq!(code(&body), "record_in_use");
    assert_eq!(body["error"]["reasons"], json!(["move_workplaces_first"]));

    // Registration must not be voided
    let is_voided: bool = sqlx::query_scalar(
        "SELECT voided_at IS NOT NULL FROM business_registrations WHERE id = $1",
    )
    .bind(reg_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!is_voided, "registration must not be voided");
    assert_eq!(
        count(&pool, "business_registrations", org).await,
        before_voided
    );
}

/// After go_live (phase OPERATING), voiding an unused registration is refused
/// with 409 Conflict (code: phase_not_setup, remedy: close_record_instead).
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn void_registration_refuses_outside_setup_phase(pool: PgPool) {
    let (org, owner) = tenant(&pool, ADMIN).await;
    let ctx = ctx(&pool, org, owner, ADMIN, None).await;

    let (status, entity) = ctx
        .call("POST", "/api/v1/legal-entities", Some(entity_body()))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{entity}");
    let entity_id = entity["record"]["id"].as_str().unwrap();

    let (status, reg) = ctx
        .call(
            "POST",
            &format!("/api/v1/legal-entities/{entity_id}/registrations"),
            Some(registration_body(VALID_BRN)),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{reg}");
    let reg_id = reg["record"]["id"].as_str().unwrap();

    // Advance tenant to OPERATING phase
    go_live(&pool, org).await;

    let (status, body) = ctx
        .call(
            "POST",
            &format!("/api/v1/business-registrations/{reg_id}/void"),
            Some(json!({ "reason_code": "MISTAKE" })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{status} {body}");
    assert_eq!(code(&body), "phase_not_setup");
    assert_eq!(body["error"]["reasons"], json!(["close_record_instead"]));

    // Registration must remain active (not voided)
    let is_voided: bool = sqlx::query_scalar(
        "SELECT voided_at IS NOT NULL FROM business_registrations WHERE id = $1",
    )
    .bind(Uuid::parse_str(reg_id).unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!is_voided, "registration must not be voided");
}
