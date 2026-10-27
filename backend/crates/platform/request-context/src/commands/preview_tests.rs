// SPDX-License-Identifier: LicenseRef-Proprietary
use super::test_support::Fixture;
use axum::{Extension, body::Body, extract::Request};
use console_platform_test_support::MIGRATOR;
use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;
use tower::ServiceExt;

#[sqlx::test(migrator = "MIGRATOR")]
async fn opted_in_previews_claim_nothing_on_a_non_settings_route(pool: PgPool) {
    let f = Fixture::new(pool).await;
    for query in ["true", "%74rue"] {
        let response = f
            .router()
            .layer(Extension(super::SupportsDryRun))
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/probe?dry_run={query}"))
                    .header("content-type", "application/json")
                    .header("idempotency-key", "preview-then-write")
                    .body(Body::from(json!({"mode": "preview"}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let counts: (i64, i64) = sqlx::query_as(
            "SELECT (SELECT count(*) FROM command_outcomes WHERE org_id=$1),
                    (SELECT count(*) FROM audit_events WHERE org_id=$1)",
        )
        .bind(f.principal.org_id.as_uuid())
        .fetch_one(&f.owner)
        .await
        .unwrap();
        assert_eq!(counts, (0, 0));
    }
    assert_eq!(
        f.send("preview-then-write", json!({"value": "applied"}))
            .await
            .status(),
        StatusCode::CREATED
    );
    assert_eq!(f.writes().await, 1);
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn a_query_alone_or_a_marker_alone_cannot_bypass_write_admission(pool: PgPool) {
    let f = Fixture::new(pool).await;
    for (opt_in, query) in [
        (false, "true"),
        (true, "false"),
        (true, "invalid"),
        (true, "true&dry_run=false"),
    ] {
        let key = format!("actual-write-{opt_in}-{query}");
        for (value, expected) in [(1, StatusCode::CREATED), (2, StatusCode::CONFLICT)] {
            let router = if opt_in {
                f.router().layer(Extension(super::SupportsDryRun))
            } else {
                f.router()
            };
            let response = router
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(format!("/probe?dry_run={query}"))
                        .header("content-type", "application/json")
                        .header("idempotency-key", &key)
                        .body(Body::from(json!({"value": value}).to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
        }
    }
    assert_eq!(f.writes().await, 4);
}
