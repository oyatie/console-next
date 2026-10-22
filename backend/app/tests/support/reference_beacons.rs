// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_eight_character_display_reference_resolves_the_full_failure(pool: PgPool) {
    let store = Store::start().await;
    let (org, user) = support::tenant(&pool, &["SUPER_ADMIN"]).await;
    let owner = ctx(&pool, org, user, &["SUPER_ADMIN"], &store).await;
    let body = refusal(&owner, &store).await;
    let reference = body["error"]["support_ref"].as_str().unwrap();
    let (status, resolved) = owner
        .call(
            "GET",
            &format!("/api/v1/support-references/{}", &reference[..8]),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{resolved}");
    assert_eq!(resolved["support_ref"], reference);
    assert_eq!(resolved["trace_id"], body["error"]["trace_id"]);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn lazy_chunk_reference_resolves_the_client_route_and_previous_release(pool: PgPool) {
    use axum::body::{Body, to_bytes};
    use http::Request;
    use tower::ServiceExt;
    let store = Store::start().await;
    let (org, user) = support::tenant(&pool, &["SUPER_ADMIN"]).await;
    let owner = ctx(&pool, org, user, &["SUPER_ADMIN"], &store).await;
    let response = owner.service.clone().oneshot(Request::post("/api/v1/client-errors")
        .header("authorization", format!("Bearer {}", owner.token))
        .header("accept", "application/json")
        .body(Body::from(r#"{"kind":"reference","name":"ChunkLoadError","build":"oldEntry","release":"previous-deploy","route":"/people/:id"}"#)).unwrap())
        .with_subscriber(store.subscriber()).await.unwrap();
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let receipt: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    let reference = receipt["support_ref"].as_str().unwrap();
    for value in [reference, &reference[..8]] {
        let (status, resolved) = owner
            .call("GET", &format!("/api/v1/support-references/{value}"), None)
            .await;
        assert_eq!(status, StatusCode::OK, "{resolved}");
        assert_eq!(resolved["support_ref"], reference);
        assert_eq!(resolved["trace_id"], reference);
        assert_eq!(resolved["route_template"], "/people/:id");
        assert_eq!(resolved["release"], "previous-deploy");
    }
    let raw = String::from_utf8(store.logs.0.lock().unwrap().clone()).unwrap();
    let event = raw
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .find(|event| event["fields"]["message"] == "support reference")
        .unwrap();
    assert_eq!(event["fields"]["kind"], "reference");
    assert_eq!(event["fields"]["name"], "ChunkLoadError");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn short_reference_collisions_never_resolve_an_arbitrary_failure(pool: PgPool) {
    use std::io::Write;
    let store = Store::start().await;
    let (org, user) = support::tenant(&pool, &["SUPER_ADMIN"]).await;
    let owner = ctx(&pool, org, user, &["SUPER_ADMIN"], &store).await;
    for reference in [
        "0123456789abcdef0123456789abcdef",
        "01234567ffffffffffffffffffffffff",
    ] {
        let fields = serde_json::json!({"message":"support reference", "support_ref":reference, "trace_id":reference, "release":"entry", "route_template":"/people/:id", "org_id":org, "support_ref_at":"2026-10-22T00:00:00Z"});
        writeln!(
            store.logs.clone(),
            "{}",
            serde_json::json!({"fields":fields})
        )
        .unwrap();
    }
    let (status, body) = owner
        .call("GET", "/api/v1/support-references/01234567", None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["error"]["code"], "support_reference_not_found");
    assert_eq!(store.reads.load(std::sync::atomic::Ordering::Relaxed), 1);
}
