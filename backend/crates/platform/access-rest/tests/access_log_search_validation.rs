// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod support;

use axum::http::{Method, StatusCode};
use sqlx::PgPool;
use support::world;

async fn refuses(w: &support::World, term: &str) {
    let encoded: String = term.bytes().map(|b| format!("%{b:02X}")).collect();
    let (status, body) = w
        .call(
            Method::GET,
            &format!("/api/v1/access/access-log?period=2026-09&search={encoded}"),
            w.ops,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["code"], "search_invalid");
    let reads: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='access_log.review_read'",
    )
    .bind(w.org)
    .fetch_one(&w.owner)
    .await
    .unwrap();
    assert_eq!(reads, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn search_refuses_nul_before_postgres(pool: PgPool) {
    refuses(&world(pool).await, "actor\0name").await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn search_refuses_controls_before_trimming(pool: PgPool) {
    let w = world(pool).await;
    for term in ["\t", "\nactor", "actor\r", "a\u{1f}b", "\u{7f}", "\u{85}"] {
        refuses(&w, term).await;
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn search_bounds_raw_unicode_characters(pool: PgPool) {
    let w = world(pool).await;
    for term in ["a".repeat(201), "가".repeat(201), " ".repeat(201)] {
        refuses(&w, &term).await;
    }
    for term in ["a".repeat(200), "가".repeat(200), " ".repeat(200)] {
        let encoded: String = term.bytes().map(|b| format!("%{b:02X}")).collect();
        let (status, body) = w
            .call(
                Method::GET,
                &format!("/api/v1/access/access-log?period=2026-09&search={encoded}"),
                w.ops,
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
}
