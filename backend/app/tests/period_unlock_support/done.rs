// SPDX-License-Identifier: LicenseRef-Proprietary
use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use serde_json::Value;
use tower::ServiceExt;
use uuid::Uuid;

/// Inbox Done after a decision: the decider (first token) sees the request
/// with its outcome, the requester (second token) sees nothing.
pub async fn finished(
    service: &axum::Router,
    tokens: [&str; 2],
    request: Uuid,
    lock: Uuid,
    outcome: &str,
) {
    let mut seen = Vec::new();
    for token in tokens {
        let response = service
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/me/action-inbox/done")
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        seen.push(serde_json::from_slice::<Value>(&bytes).unwrap()["items"].clone());
    }
    let row = seen[0]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["id"] == format!("period_unlock:{request}"))
        .unwrap();
    assert_eq!(
        (row["outcome"].as_str(), row["title"].as_str()),
        (Some(outcome), Some("요청자")),
        "{row}"
    );
    assert_eq!(
        row["links"][0],
        serde_json::json!({"kind": "period_lock", "id": lock})
    );
    assert_eq!(seen[1], serde_json::json!([]));
}
