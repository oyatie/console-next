// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "support/http.rs"]
mod http;
use ::http::StatusCode;
use serde_json::json;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_served_projection_matches_the_real_calculation_authority(pool: PgPool) {
    let (org, owner) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let reader = http::add_user(&pool, org, &["MEMBER"]).await;
    for (actor, roles, authorized) in [(owner, "SUPER_ADMIN", true), (reader, "MEMBER", false)] {
        let ctx = http::ctx(&pool, org, actor, &[roles], None).await;
        let (status, projection) = ctx.call("GET", "/api/v1/me/authz", None).await;
        assert_eq!(status, StatusCode::OK, "{projection}");
        let listed = projection["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["feature"] == "analytics_projection");
        assert_eq!(listed, cfg!(feature = "analytics-quant") && authorized);
        let (status, result) = ctx
            .call(
                "POST",
                "/api/v1/analytics/projection",
                Some(json!({
                    "series": [10000, 10000, 10000], "horizon": 3, "kind": "money"
                })),
            )
            .await;
        if cfg!(feature = "analytics-quant") && authorized {
            assert_eq!(status, StatusCode::OK, "{result}");
            for key in ["point_estimate", "ci95_low", "ci95_high", "cvar95"] {
                assert_eq!(result[key].as_f64(), Some(10000.0));
            }
        } else {
            assert_eq!(
                status,
                if cfg!(feature = "analytics-quant") {
                    StatusCode::FORBIDDEN
                } else {
                    StatusCode::NOT_FOUND
                },
                "{result}"
            );
            assert!(result.get("point_estimate").is_none());
        }
    }
}
