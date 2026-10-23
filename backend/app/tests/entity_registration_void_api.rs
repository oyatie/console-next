// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Acceptance and negative suite for voidBusinessRegistration (`POST /api/v1/business-registrations/{id}/void`).
//!
//! Asserts permission and tenant boundaries, refusal remedies, record_in_use only
//! for non-voided workplaces, idempotent replay, and zero business writes on refusals.

use console_kernel_core::{AccessScope, AccessScopeLevel, OrgId, ScopeNodeId};
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings};
use console_platform_test_support::soft_passkey::SoftKey;
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[path = "support/http.rs"]
mod support;
use support::{add_user, address, ctx, entity_body, structure, tenant};

#[path = "support/refusals.rs"]
mod refusals;
use refusals::code;

const ADMIN: &[&str] = &["SUPER_ADMIN"];

async fn refused(
    pool: &PgPool,
    ctx: &support::Ctx,
    method: &str,
    uri: &str,
    body: Option<Value>,
    status: StatusCode,
    want: &str,
) -> Value {
    let business = refusals::business_state(pool, ctx.org).await;
    let audits = refusals::audit_rows(pool, ctx.org).await;
    let commands = support::count(pool, "command_outcomes", ctx.org).await;
    let (got, first) = ctx.call(method, uri, body.clone()).await;
    assert_eq!(got, status, "{first}");
    assert!(
        code(&first) == want || refusals::field_codes(&first).iter().any(|(_, c)| c == want),
        "expected {want}: {first}"
    );
    assert_eq!(refusals::business_state(pool, ctx.org).await, business);
    assert_eq!(refusals::audit_rows(pool, ctx.org).await, audits + 2);
    assert_eq!(
        support::count(pool, "command_outcomes", ctx.org).await,
        commands + 1
    );
    refusals::refused(pool, ctx, method, uri, body, status, want).await;
    first
}

async fn registration_of(pool: &PgPool, entity: &str) -> String {
    let id: Uuid =
        sqlx::query_scalar("SELECT id FROM business_registrations WHERE legal_entity_id = $1")
            .bind(Uuid::parse_str(entity).unwrap())
            .fetch_one(pool)
            .await
            .unwrap();
    id.to_string()
}

async fn create_unattached_registration(ctx: &support::Ctx, brn: &str) -> String {
    let mut entity = entity_body();
    entity["name"] = json!("주식회사 나다");
    let (status, created) = ctx
        .call("POST", "/api/v1/legal-entities", Some(entity))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let entity_id = created["record"]["id"].as_str().unwrap();

    let (status, reg) = ctx
        .call(
            "POST",
            &format!("/api/v1/legal-entities/{entity_id}/registrations"),
            Some(json!({
                "brn": brn,
                "trade_name": "주식회사 나다",
                "opened_on": "2020-03-02",
                "business_address": address(),
                "unit_taxation": false,
                "tax_office_label": "역삼세무서",
                "tax_type": "01",
                "business_types": [{
                    "is_main": true,
                    "sector": "정보통신업",
                    "item": "응용 소프트웨어 개발"
                }],
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{reg}");
    reg["record"]["id"].as_str().unwrap().to_owned()
}

include!("entity_registration_void/permissions.rs");
include!("entity_registration_void/lifecycle.rs");
include!("entity_registration_void/replay.rs");
include!("entity_registration_void/concurrency.rs");
