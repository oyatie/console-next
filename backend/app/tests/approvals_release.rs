// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "support/approvals.rs"]
mod fixtures;
#[path = "../../test-support/org_change_fixtures.rs"]
mod grants;
#[path = "support/http.rs"]
mod http;
#[path = "../../test-support/person_fixtures.rs"]
mod people;
use console_app::{
    AppConfig, AppState, CONFIGURED_ROUTE_SURFACES, DatabaseDependency, build_router,
};
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn approvals_readiness_and_endpoints_require_the_deployment_release_toggle(pool: PgPool) {
    let (org, user, _) = fixtures::setup(&pool).await;
    let id = fixtures::document(&pool, org, user, "OC-2026-0001").await;
    sqlx::query("UPDATE tenant_phase SET phase='OPERATING' WHERE org_id=$1")
        .bind(org)
        .execute(&pool)
        .await
        .unwrap();
    let mut ctx = fixtures::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    let keys = http::keys();
    ctx.token = http::token(&pool, &keys, org, user, &["SUPER_ADMIN"]).await;
    for (toggles, expected) in [
        (None, false),
        (Some("other-feature"), false),
        (Some("approvals"), true),
    ] {
        let mut pairs = vec![
            ("CONSOLE_JWT_PUBLIC_KEY_PEM", keys.1.clone()),
            ("CONSOLE_JWT_ISSUER", "console-platform-auth".into()),
            ("CONSOLE_JWT_AUDIENCE", "console-api".into()),
        ];
        if let Some(toggles) = toggles {
            pairs.push(("CONSOLE_RELEASE_TOGGLES", toggles.into()));
        }
        let config = AppConfig::from_pairs(pairs).unwrap();
        ctx.service = build_router(
            AppState::new(
                config,
                DatabaseDependency::Postgres(
                    console_platform_test_support::runtime_role_pool(&pool).await,
                ),
            )
            .unwrap(),
        );
        let (status, body) = ctx.call("GET", "/api/v1/onboarding/modules", None).await;
        assert_eq!(status, ::http::StatusCode::OK, "{body}");
        assert!(
            body.as_array()
                .unwrap()
                .iter()
                .any(|m| m["key"] == "approvals" && m["ready"] == expected),
            "{toggles:?}: {body}"
        );
        let mut responses = Vec::new();
        for path in [
            "/api/v1/approvals?box=requested".to_owned(),
            format!("/api/v1/approvals/org_change:{id}"),
        ] {
            let (status, body) = ctx.call("GET", &path, None).await;
            responses.push((path, status, body));
        }
        let expected_status = if expected {
            ::http::StatusCode::OK
        } else {
            ::http::StatusCode::NOT_FOUND
        };
        assert!(
            responses
                .iter()
                .all(|(_, status, body)| *status == expected_status
                    && (expected
                        || (body["error"]["code"] == "not_found"
                            && body.get("items").is_none()
                            && body.get("document_no").is_none()))),
            "{toggles:?}: {responses:?}"
        );
    }
}

#[test]
fn approvals_inventory_includes_both_mounted_routes() {
    let approvals = CONFIGURED_ROUTE_SURFACES
        .iter()
        .find(|s| s.name == "approvals")
        .unwrap();
    assert_eq!(
        approvals.paths,
        ["/api/v1/approvals", "/api/v1/approvals/{id}"]
    );
}
