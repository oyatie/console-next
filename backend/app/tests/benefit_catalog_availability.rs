// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "support/http.rs"]
mod http;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn catalog_availability_matches_the_installed_module(pool: sqlx::PgPool) {
    use ::http::StatusCode;
    let (org, admin) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, org, admin, &["SUPER_ADMIN"], None).await;
    let (status, projection) = ctx.call("GET", "/api/v1/me/authz", None).await;
    assert_eq!(status, StatusCode::OK, "{projection}");
    for cap in ["served_benefit_catalog", "served_benefit_catalog_manage"] {
        let present = projection["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["feature"] == cap);
        assert_eq!(present, cfg!(feature = "benefit"), "{cap}");
    }
    let (status, body) = ctx.call("GET", "/api/v1/benefit-catalog/items", None).await;
    let expected = if cfg!(feature = "benefit") {
        StatusCode::OK
    } else {
        StatusCode::NOT_FOUND
    };
    assert_eq!(status, expected, "{body}");
}

#[cfg(feature = "benefit")]
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn executive_can_inspect_catalog_but_has_no_management_capability(pool: sqlx::PgPool) {
    use ::http::StatusCode;
    let (org, viewer) = http::tenant(&pool, &["EXECUTIVE"]).await;
    let ctx = http::ctx(&pool, org, viewer, &["EXECUTIVE"], None).await;
    let (status, projection) = ctx.call("GET", "/api/v1/me/authz", None).await;
    assert_eq!(status, StatusCode::OK, "{projection}");
    let caps = projection["capabilities"].as_array().unwrap();
    let read = caps
        .iter()
        .find(|cap| cap["feature"] == "served_benefit_catalog")
        .unwrap();
    assert_eq!(read["branch_scope"], serde_json::json!({"kind":"all"}));
    assert!(
        !caps
            .iter()
            .any(|cap| cap["feature"] == "served_benefit_catalog_manage")
    );
    let (status, body) = ctx.call("GET", "/api/v1/benefit-catalog/items", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = ctx.call("POST", "/api/v1/benefit-catalog/items", Some(serde_json::json!({
        "scope":{"scope_type":"ORG"},"category":"extra","name":"Transit","costLabel":"Monthly","coverageLabel":"Branch staff"
    }))).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
}
