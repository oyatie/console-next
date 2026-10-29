// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use common::*;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const PATH: &str = "/api/v1/onboarding/modules";

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn no_grant_account_reads_readiness_without_counts(owner: PgPool) {
    let h = harness(&owner, false).await;
    let (status, data) = send(&h, "GET", PATH, Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{data}");
    let modules = data.as_array().unwrap();
    assert_eq!(
        modules
            .iter()
            .filter(|m| m["ready"] == true)
            .map(|m| m["key"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["home", "org", "access"]
    );
    for module in modules {
        assert_eq!(module.as_object().unwrap().len(), 3);
        assert!(
            module.get("key").is_some()
                && module.get("ready").is_some()
                && module.get("unblock").is_some()
        );
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn token_always_reads_its_own_tenant(owner: PgPool) {
    let a = harness(&owner, true).await;
    let b = harness(&owner, false).await;
    // rls-arming: ok owner seeds a distinct tenant fact to expose an isolation failure.
    sqlx::query("INSERT INTO legal_entities (org_id, id, needs_confirmation, created_change_mode) VALUES ($1, $2, true, 'MIGRATION')").bind(a.actor.org.as_uuid()).bind(uuid::Uuid::new_v4()).execute(&owner).await.unwrap();
    let (status, data) = send(
        &b,
        "GET",
        &format!("{PATH}?org_id={}", a.actor.org.as_uuid()),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{data}");
    assert!(
        data.as_array()
            .unwrap()
            .iter()
            .any(|m| m["key"] == "people" && m["unblock"] == "create_legal_entity")
    );
    let (status, data) = send(&a, "GET", PATH, json!(null)).await;
    assert_eq!(status, StatusCode::OK, "{data}");
    assert!(
        data.as_array()
            .unwrap()
            .iter()
            .any(|m| m["key"] == "people" && m["unblock"] == "create_workplace")
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unauthenticated_modules_read_is_unauthorized(owner: PgPool) {
    let h = harness(&owner, true).await;
    let response = h
        .app
        .oneshot(Request::builder().uri(PATH).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}
