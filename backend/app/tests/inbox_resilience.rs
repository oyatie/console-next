// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "support/http.rs"]
mod http;
use ::http::StatusCode;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_unavailable_source_keeps_setup_work_and_a_retry_restores_exactness(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    let (status, before) = ctx
        .call("GET", "/api/v1/me/action-inbox?filter=turn", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{before}");
    sqlx::query("ALTER TABLE change_requests RENAME TO inbox_unavailable_requests")
        .execute(&pool)
        .await
        .unwrap();
    let (status, partial) = ctx
        .call("GET", "/api/v1/me/action-inbox?filter=turn", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{partial}");
    assert_eq!(
        partial["items"], before["items"],
        "healthy setup work must survive"
    );
    assert_eq!(partial["total_is_exact"], false);
    assert_eq!(partial["counts"]["turn"]["total_is_exact"], false);
    assert_eq!(partial["unavailable"][0]["source"], "hr_requests");
    let reference = partial["unavailable"][0]["support_reference"]
        .as_str()
        .unwrap();
    assert_eq!(reference.len(), 32);
    assert!(reference.bytes().all(|b| b.is_ascii_hexdigit()));
    assert!(!partial.to_string().contains("inbox_unavailable_requests"));
    sqlx::query("ALTER TABLE inbox_unavailable_requests RENAME TO change_requests")
        .execute(&pool)
        .await
        .unwrap();
    let (status, restored) = ctx
        .call("GET", "/api/v1/me/action-inbox?filter=turn", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{restored}");
    assert_eq!(restored["unavailable"], serde_json::json!([]));
    assert_eq!(restored["total_is_exact"], true);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn work_grants_control_no_work_and_each_empty_queue_start(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    let (_, page) = ctx
        .call("GET", "/api/v1/me/action-inbox?filter=turn", None)
        .await;
    assert_eq!(page["has_work"], true);
    assert_eq!(
        page["quick_starts"],
        serde_json::json!(["register", "import", "org", "invite"])
    );
    assert!(page["as_of"].is_string());
    assert_eq!(
        page["counts"]["turn"]["total"],
        page["items"].as_array().unwrap().len()
    );
    for filter in ["waiting", "scheduled", "deadlines", "failures"] {
        let (status, view) = ctx
            .call(
                "GET",
                &format!("/api/v1/me/action-inbox?filter={filter}"),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{view}");
        assert_eq!(
            view["counts"], page["counts"],
            "counts cannot depend on selected view"
        );
    }
    let nobody = http::add_user(&pool, org, &[]).await;
    let nobody = http::ctx(&pool, org, nobody, &[], None).await;
    let (_, page) = nobody
        .call("GET", "/api/v1/me/action-inbox?filter=turn", None)
        .await;
    assert_eq!(page["has_work"], false);
    assert_eq!(page["quick_starts"], serde_json::json!([]));
    assert!(
        page["counts"]
            .as_object()
            .unwrap()
            .values()
            .all(|c| c["total"] == 0)
    );
}
