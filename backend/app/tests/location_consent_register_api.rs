// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "support/http.rs"]
mod http;
use ::http::StatusCode;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

const LEDGER: &str = "/api/v1/location-consents/ledger";
const CAP: &str = "served_location_consent_ledger";

async fn branch(pool: &PgPool, org: Uuid, name: &str) -> Uuid {
    sqlx::query_scalar("WITH r AS (INSERT INTO regions (org_id,name) VALUES ($1,$2) RETURNING id) INSERT INTO branches (org_id,region_id,name) SELECT $1,id,$2 FROM r RETURNING id")
        .bind(org).bind(name).fetch_one(pool).await.unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ledger_navigation_and_reads_agree_for_the_current_binary_and_branch(pool: PgPool) {
    let (org, admin) = http::tenant(&pool, &["ADMIN"]).await;
    let viewer = http::add_user(&pool, org, &["MEMBER"]).await;
    let allowed = branch(&pool, org, "A").await;
    let outside = branch(&pool, org, "B").await;
    for id in [admin, viewer] {
        sqlx::query("INSERT INTO user_branches (user_id,branch_id,org_id) VALUES ($1,$2,$3)")
            .bind(id.as_uuid())
            .bind(allowed)
            .bind(org)
            .execute(&pool)
            .await
            .unwrap();
    }
    for (user, role, permitted) in [(admin, "ADMIN", true), (viewer, "MEMBER", false)] {
        let ctx = http::ctx(&pool, org, user, &[role], None).await;
        let (status, projection) = ctx.call("GET", "/api/v1/me/authz", None).await;
        assert_eq!(status, StatusCode::OK, "{projection}");
        let cap = projection["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["feature"] == CAP);
        assert_eq!(cap.is_some(), cfg!(feature = "compliance") && permitted);
        if let Some(cap) = cap {
            assert_eq!(cap["org_wide"], false);
            assert_eq!(
                cap["branch_scope"],
                json!({"kind":"branches","branches":[allowed]})
            );
        }
        for (branch, granted) in [(allowed, permitted), (outside, false)] {
            for route in [LEDGER, "/api/v1/location-consents/ledger.csv"] {
                let (status, result) = ctx
                    .call("GET", &format!("{route}?branch_id={branch}"), None)
                    .await;
                let expected = if !cfg!(feature = "compliance") {
                    StatusCode::NOT_FOUND
                } else if granted {
                    StatusCode::OK
                } else {
                    StatusCode::FORBIDDEN
                };
                assert_eq!(status, expected, "{role} {route} {branch}: {result}");
            }
        }
    }
}

#[cfg(feature = "compliance")]
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tenant_wide_consent_reads_include_only_the_authorized_tenant_events(pool: PgPool) {
    let mut tenants = Vec::new();
    for label in ["North", "South"] {
        let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
        let branch = branch(&pool, org, label).await;
        let ctx = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
        let (status, grant) = ctx
            .call(
                "POST",
                "/api/v1/location-consent/grant",
                Some(json!({"branch_id":branch})),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{grant}");
        tenants.push((ctx, branch));
    }
    for (ctx, branch) in tenants {
        let (_, projection) = ctx.call("GET", "/api/v1/me/authz", None).await;
        assert!(
            projection["capabilities"]
                .as_array()
                .unwrap()
                .iter()
                .any(|cap| cap["feature"] == CAP && cap["org_wide"] == true)
        );
        let (status, page) = ctx.call("GET", LEDGER, None).await;
        assert_eq!(status, StatusCode::OK, "{page}");
        assert_eq!(page["total"], 1);
        assert_eq!(page["items"][0]["branch_id"], json!(branch));
        assert_eq!(page["items"][0]["user_id"], json!(ctx.user));
    }
}
