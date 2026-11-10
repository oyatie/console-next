// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn invalid_list_queries_are_refused_without_reading_documents(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = fixtures::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    for query in [
        "box=invalid",
        "box=pending&cursor=bad",
        "box=pending&limit=0",
        "box=pending&limit=101",
    ] {
        assert_eq!(
            ctx.call("GET", &format!("/api/v1/approvals?{query}"), None)
                .await
                .0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn projection_failures_return_a_code_without_database_details(pool: PgPool) {
    let (org, maker, checker) = setup(&pool).await;
    document(&pool, org, maker, "OC-2026-0001").await;
    let ctx = fixtures::ctx(&pool, org, checker, &["EXECUTIVE"], None).await;
    sqlx::query("ALTER TABLE org_units RENAME TO unavailable_org_units")
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = ctx.call("GET", "/api/v1/approvals?box=pending", None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    assert_eq!(body["error"]["code"], "approvals.projection_unavailable");
    assert_eq!(body["error"]["message"], "internal server error");
    assert!(
        body["error"]["support_ref"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
    );
    assert!(!body.to_string().contains("org_units"));
}
