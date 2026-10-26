// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Pin the server projection consumed by the console's route guard.
mod support;

use axum::http::{Method, StatusCode};
use serde_json::json;
use sqlx::PgPool;
use support::{grant_op, world};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn route_refusal_and_implied_view_are_server_decisions(pool: PgPool) {
    let mut w = world(pool).await;
    for path in [
        "/api/v1/access/roles".to_owned(),
        "/api/v1/access/grants".to_owned(),
        format!("/api/v1/access/accounts/{}/effective", w.hr.as_uuid()),
    ] {
        let (status, body) = w.call(Method::GET, &path, w.hr, None).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{path}: {body}");
        assert_eq!(body["error"]["code"], "access_denied", "{body}");
    }
    let role = w
        .role(
            "인사 실무",
            json!([{ "domain": "hr_basic", "levels": ["edit"] }]),
        )
        .await;
    w.grant(json!([grant_op(
        w.hr,
        role,
        "LEGAL_ENTITY",
        Some(w.le_a),
        true
    )]))
    .await;
    let (status, me) = w.call(Method::GET, "/api/v1/access/me", w.hr, None).await;
    assert_eq!(status, StatusCode::OK, "{me}");
    let entries = me["entries"].as_array().unwrap();
    assert_eq!(
        entries.len(),
        2,
        "edit is normalized to view and edit: {me}"
    );
    for level in ["view", "edit"] {
        let entry = entries.iter().find(|e| e["level"] == level).unwrap();
        assert_eq!(entry["domain"], "hr_basic");
        assert_eq!(entry["enforcement"], "ENFORCED", "{entry}");
        assert_eq!(entry["scope"]["kind"], "LEGAL_ENTITY");
        assert_eq!(entry["scope"]["node_id"], w.le_a.to_string());
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn single_domain_readers_keep_their_distinct_effective_permissions(pool: PgPool) {
    let mut w = world(pool).await;
    for (account, domain, level, expected_status) in [
        (w.hr, "hr_basic", "view", StatusCode::FORBIDDEN),
        (w.hr2, "access", "edit", StatusCode::OK),
    ] {
        let role = w
            .role(domain, json!([{ "domain": domain, "levels": [level] }]))
            .await;
        w.grant(json!([grant_op(account, role, "TENANT", None, true)]))
            .await;
        let (status, me) = w
            .call(Method::GET, "/api/v1/access/me", account, None)
            .await;
        assert_eq!(status, StatusCode::OK, "{me}");
        assert_eq!(me["is_ops"], false);
        let entries = me["entries"].as_array().unwrap();
        assert!(!entries.is_empty());
        assert!(entries.iter().all(|entry| {
            entry["domain"] == domain
                && entry["enforcement"] == "ENFORCED"
                && entry["scope"]["kind"] == "TENANT"
        }));
        assert!(entries.iter().any(|entry| entry["level"] == level));
        let (status, body) = w
            .call(Method::GET, "/api/v1/access/roles", account, None)
            .await;
        assert_eq!(status, expected_status, "{body}");
    }
}
