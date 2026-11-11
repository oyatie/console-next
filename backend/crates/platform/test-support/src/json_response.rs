// SPDX-License-Identifier: LicenseRef-Proprietary
use axum::body::to_bytes;
use axum::http::{StatusCode, header};
use axum::response::Response;
use serde_json::Value;

/// Decode a composed-router response and verify its JSON or problem contract.
pub async fn json_response(response: Response) -> (StatusCode, Value) {
    let status = response.status();
    let content_type = response.headers().get(header::CONTENT_TYPE).cloned();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let expected_content_type = if status.is_success() {
        "application/json"
    } else {
        "application/problem+json"
    };
    assert_eq!(
        content_type.as_ref().and_then(|value| value.to_str().ok()),
        Some(expected_content_type),
        "{status}: {}",
        String::from_utf8_lossy(&bytes)
    );
    let body: Value = serde_json::from_slice(&bytes).expect("response must be valid JSON");
    if !status.is_success() {
        assert_eq!(body["type"], "about:blank", "{status}: {body}");
        assert_eq!(body["status"], status.as_u16(), "{status}: {body}");
        assert!(body["error"]["code"].is_string(), "{status}: {body}");
    }
    (status, body)
}
