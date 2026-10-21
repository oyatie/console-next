//! Native-data assertions use a stationary deadline clock; timeout behavior
//! is covered separately by `workbench_api` with virtual time.

use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use serde_json::{Value, json};
use tower::ServiceExt;

pub(super) struct JsonResponse {
    pub status: StatusCode,
    pub json: Value,
}

pub(super) async fn get(service: axum::Router, uri: &str, token: &str) -> JsonResponse {
    let request = Request::builder()
        .uri(uri)
        .method("GET")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let runtime = tokio::runtime::Handle::current();
    tokio::time::pause();
    // A running blocking task inhibits Tokio's automatic time advance during real PostgreSQL I/O.
    let response = tokio::task::spawn_blocking(move || runtime.block_on(service.oneshot(request)))
        .await
        .unwrap()
        .unwrap();
    tokio::time::resume();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}));
    JsonResponse { status, json }
}

#[tokio::test]
async fn external_io_does_not_spend_the_native_assertions_timeout_budget() {
    let service = axum::Router::new().route(
        "/io",
        axum::routing::get(|| async {
            let io = tokio::task::spawn_blocking(|| {
                std::thread::sleep(std::time::Duration::from_secs(1));
            });
            let completed = tokio::time::timeout(std::time::Duration::from_millis(750), io)
                .await
                .is_ok();
            axum::Json(json!({"completed": completed}))
        }),
    );
    let response = get(service, "/io", "").await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.json, json!({"completed": true}));
}
