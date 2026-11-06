// SPDX-License-Identifier: LicenseRef-Proprietary
#![cfg(not(feature = "full"))]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "support/http.rs"]
mod support;

use console_app::{AppConfig, AppState, DatabaseDependency, build_router};
use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn route_telemetry_is_absent_without_full_with_or_without_spa(pool: PgPool) {
    let dist = std::env::temp_dir().join(format!("telemetry-dist-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dist).unwrap();
    std::fs::write(dist.join("index.html"), "<!doctype html><title>spa</title>").unwrap();
    let keys = support::keys();

    for roles in [&[][..], &["SUPER_ADMIN"][..]] {
        let (org, user) = support::tenant(&pool, roles).await;
        let mut ctx = support::ctx(&pool, org, user, roles, None).await;
        ctx.token = support::token(&pool, &keys, org, user, roles).await;
        for web_dist in [None, Some(&dist)] {
            let mut pairs = vec![("CONSOLE_JWT_PUBLIC_KEY_PEM", keys.1.clone())];
            if let Some(dist) = web_dist {
                pairs.push(("CONSOLE_WEB_DIST", dist.display().to_string()));
            }
            ctx.service = build_router(
                AppState::new(
                    AppConfig::from_pairs(pairs).unwrap(),
                    DatabaseDependency::Postgres(
                        support::role_pool(&pool, "console_rt", None).await,
                    ),
                )
                .unwrap(),
            );
            let (status, body) = ctx.call("GET", "/api/v1/users/me", None).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            let (status, body) = ctx
                .call(
                    "POST",
                    "/api/v1/console/telemetry/route",
                    Some(json!({
                        "event_kind": "route_selection",
                        "route_surface": "console",
                        "route_path": "/",
                        "release_cycle": "test"
                    })),
                )
                .await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
            if web_dist.is_some() {
                assert_eq!(body["error"]["code"], "not_found");
            }
        }
        let stored: i64 =
            sqlx::query_scalar("SELECT count(*) FROM console_route_telemetry WHERE org_id = $1")
                .bind(org)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stored, 0);
    }
    std::fs::remove_dir_all(dist).unwrap();
}
