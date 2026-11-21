// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]

use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;

#[allow(dead_code)]
#[path = "emp_ui_routes/harness.rs"]
mod harness;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn post_auth_signup_is_unmounted_and_returns_404(pool: PgPool) {
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&pool)
        .await
        .unwrap();
    let keys = harness::keys();
    let caller = harness::Caller {
        service: harness::router(&pool, &keys).await,
        token: None,
    };
    let (status, body) = caller
        .send(
            "POST",
            "/api/v1/auth/signup",
            Some(json!({ "email": "open-signup-probe@example.com" })),
            false,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert!(
        body["error"]["code"].is_null() || body["error"]["code"] == "not_found",
        "{body}"
    );
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(after, before);
}
