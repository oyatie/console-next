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
async fn compiled_out_payroll_stays_unready_even_with_an_enabled_setting(owner: PgPool) {
    let h = harness_with_payroll(&owner, true, false).await;
    // rls-arming: ok an enabled tenant setting cannot restore a compiled-out module.
    let effective: time::OffsetDateTime = sqlx::query_scalar("INSERT INTO tenant_setting_overrides (org_id, key, value, effective_from, set_by, reason_code) VALUES ($1, 'module.payroll.enabled', 'true', clock_timestamp(), $2, 'POLICY_REVIEW') RETURNING effective_from")
        .bind(h.actor.org.as_uuid()).bind(h.actor.user.as_uuid()).fetch_one(&owner).await.unwrap();
    if let Ok(wait) = (effective - time::OffsetDateTime::now_utc()).try_into() {
        tokio::time::sleep(wait).await;
    }
    let (status, data) = send(&h, "GET", PATH, Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{data}");
    assert!(
        data.as_array()
            .unwrap()
            .iter()
            .any(|m| m["key"] == "payroll" && m["ready"] == false)
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn payroll_readiness_uses_only_the_current_tenant_setting(owner: PgPool) {
    let a = harness(&owner, true).await;
    let b = harness(&owner, false).await;
    for h in [&a, &b] {
        let (status, data) = send(h, "GET", PATH, Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{data}");
        assert!(
            data.as_array()
                .unwrap()
                .iter()
                .any(|m| m["key"] == "payroll" && m["ready"] == true)
        );
    }
    // rls-arming: ok a scheduled deactivation must not disable the module early.
    sqlx::query("INSERT INTO tenant_setting_overrides (org_id, key, value, effective_from, set_by, reason_code) VALUES ($1, 'module.payroll.enabled', 'false', now() + interval '1 day', $2, 'POLICY_REVIEW')")
        .bind(b.actor.org.as_uuid()).bind(b.actor.user.as_uuid()).execute(&owner).await.unwrap();
    for enabled in [true, false] {
        // rls-arming: ok owner seeds an effective-dated tenant module setting.
        let effective: time::OffsetDateTime = sqlx::query_scalar("INSERT INTO tenant_setting_overrides (org_id, key, value, effective_from, set_by, reason_code) VALUES ($1, 'module.payroll.enabled', $2, clock_timestamp(), $3, 'POLICY_REVIEW') RETURNING effective_from")
            .bind(a.actor.org.as_uuid()).bind(json!(enabled)).bind(a.actor.user.as_uuid())
            .fetch_one(&owner).await.unwrap();
        if let Ok(wait) = (effective - time::OffsetDateTime::now_utc()).try_into() {
            tokio::time::sleep(wait).await;
        }
        for (h, expected) in [(&a, enabled), (&b, true)] {
            let (status, data) = send(
                h,
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
                    .any(|m| m["key"] == "payroll" && m["ready"] == expected),
                "{data}, expected payroll ready={expected}"
            );
        }
    }
}

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
        ["home", "org", "access", "approvals", "payroll"]
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
