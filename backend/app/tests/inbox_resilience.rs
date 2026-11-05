// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "support/http.rs"]
mod http;
use ::http::StatusCode;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unavailable_org_change_decision_hints_preserve_other_sources(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let request: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO org_change_requests (org_id,code,kind,status,target_kind,target_ref,\
         target_label,effective_date,reason,drafted_by,idempotency_key,request_fingerprint) \
         VALUES ($1,'OC-2026-0001','REORG','IN_APPROVAL','REGION','region','조직 개편',\
         CURRENT_DATE,'업무함 검증',$2,$3,repeat('a',64)) RETURNING id",
    )
    .bind(org)
    .bind(user.as_uuid())
    .bind(uuid::Uuid::new_v4().to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO org_change_approval_steps (org_id,request_id,step_order,role_key) VALUES ($1,$2,1,'hr')")
        .bind(org).bind(request).execute(&pool).await.unwrap();
    let ctx = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    let (status, before) = ctx.call("GET", "/api/v1/me/action-inbox", None).await;
    assert_eq!(status, StatusCode::OK, "{before}");
    let items = before["items"].as_array().unwrap();
    let pending = items
        .iter()
        .find(|row| row["id"] == format!("org_change:{request}"))
        .unwrap();
    assert!(pending["version"].is_string(), "{pending}");
    assert_eq!(pending["can_decide"], false);
    let healthy: Vec<_> = items
        .iter()
        .filter(|row| !row["kind"].as_str().unwrap().starts_with("org_change_"))
        .cloned()
        .collect();
    assert!(!healthy.is_empty(), "setup work must be present");

    // Only the hint's version read uses this column; source membership still works.
    sqlx::query(
        "ALTER TABLE org_change_requests RENAME COLUMN updated_at TO unavailable_hint_version",
    )
    .execute(&pool)
    .await
    .unwrap();
    let (status, partial) = ctx.call("GET", "/api/v1/me/action-inbox", None).await;
    let (waiting_status, waiting) = ctx
        .call("GET", "/api/v1/me/action-inbox?filter=waiting", None)
        .await;
    sqlx::query(
        "ALTER TABLE org_change_requests RENAME COLUMN unavailable_hint_version TO updated_at",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(status, StatusCode::OK, "{partial}");
    assert_eq!(waiting_status, StatusCode::OK, "{waiting}");
    assert_eq!(waiting["items"], serde_json::json!([]));
    assert_eq!(waiting["unavailable"].as_array().unwrap().len(), 1);
    assert_eq!(waiting["unavailable"][0]["source"], "org_change");
    assert_eq!(waiting["counts"], partial["counts"]);
    assert_eq!(partial["items"], serde_json::json!(healthy));
    assert_eq!(partial["total_is_exact"], false);
    assert_eq!(partial["counts"]["waiting"]["total_is_exact"], false);
    assert_eq!(partial["unavailable"].as_array().unwrap().len(), 1);
    assert_eq!(partial["unavailable"][0]["source"], "org_change");
    let reference = partial["unavailable"][0]["support_reference"]
        .as_str()
        .unwrap();
    assert_eq!(reference.len(), 32);
    assert!(reference.bytes().all(|b| b.is_ascii_hexdigit()));
    assert!(!partial.to_string().contains("unavailable_hint_version"));

    let (status, restored) = ctx.call("GET", "/api/v1/me/action-inbox", None).await;
    assert_eq!(status, StatusCode::OK, "{restored}");
    assert_eq!(restored["items"], before["items"]);
    assert_eq!(restored["unavailable"], serde_json::json!([]));
    assert_eq!(restored["total_is_exact"], true);
}

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
