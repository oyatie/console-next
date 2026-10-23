// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use super::*;

fn run(status: StatusCode, json: bool, body: &str) -> (StatusCode, Value) {
    let rewritten = rewrite(status, (json, false), body.as_bytes(), || "t-1".to_owned()).unwrap();
    (rewritten.status, rewritten.body)
}

#[test]
fn a_500_keeps_its_code_and_loses_the_sql_text() {
    let body = r#"{"error":{"code":"internal","message":"error returned from database: relation \"employees\" does not exist"}}"#;
    let (status, json) = run(StatusCode::INTERNAL_SERVER_ERROR, true, body);
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        json,
        json!({"error": {"code": "internal", "message": "internal server error", "trace_id": "t-1"}})
    );
}

#[test]
fn a_502_with_a_sender_error_is_generic() {
    let body = r#"{"error":{"code":"bad_gateway","message":"could not send the verification email: smtp 535 auth failed"}}"#;
    let (_, json) = run(StatusCode::BAD_GATEWAY, true, body);
    assert_eq!(json["error"]["message"], "an upstream service failed");
    assert_eq!(json["error"]["code"], "bad_gateway");
}

/// regression (PERF-BE): a crate that maps the session check's pool
/// timeout to an opaque 500 (`/org-structure`: code `internal`, no text)
/// answered 500 under load; the request's helper timeout makes it a shed.
#[test]
fn regression_an_opaque_500_after_a_pool_timeout_is_a_503_with_retry_after() {
    let body = r#"{"error":{"code":"internal","message":"internal server error"}}"#;
    let shed = rewrite(
        StatusCode::INTERNAL_SERVER_ERROR,
        (true, true),
        body.as_bytes(),
        String::new,
    )
    .unwrap();
    assert_eq!(
        (shed.status, shed.retry),
        (StatusCode::SERVICE_UNAVAILABLE, true)
    );
    assert_eq!(shed.body["error"]["code"], "unavailable");
    let (status, _) = run(StatusCode::INTERNAL_SERVER_ERROR, true, body);
    assert_eq!(
        status,
        StatusCode::INTERNAL_SERVER_ERROR,
        "no timeout: a fault"
    );
}

#[test]
fn a_plain_text_rejection_becomes_the_json_envelope() {
    let (status, json) = run(
        StatusCode::BAD_REQUEST,
        false,
        "Failed to parse the request body as JSON: EOF while parsing",
    );
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(json["error"]["code"], "bad_request");
    assert_eq!(
        json["error"]["message"],
        "Failed to parse the request body as JSON: EOF while parsing"
    );
    assert!(json["error"].get("trace_id").is_none());
    let (_, json) = run(
        StatusCode::PAYLOAD_TOO_LARGE,
        false,
        "length limit exceeded",
    );
    assert_eq!(json["error"]["code"], "payload_too_large");
}

#[test]
fn a_pool_timeout_alone_earns_retry_after_and_readyz_is_untouched() {
    let pool = r#"{"error":{"code":"internal","message":"internal server error"}}"#;
    let check = |body: &str, timed_out| {
        rewrite(
            StatusCode::SERVICE_UNAVAILABLE,
            (true, timed_out),
            body.as_bytes(),
            String::new,
        )
    };
    assert!(check(pool, true).unwrap().retry);
    let unconfigured =
        r#"{"error":{"code":"service_unavailable","message":"x is not configured"}}"#;
    assert!(!check(unconfigured, false).unwrap().retry);
    // /readyz reports its dependencies in its own 503 body: not an envelope.
    assert!(check(r#"{"status":"not_ready","database":"unreachable"}"#, false).is_none());
}

#[test]
fn a_panic_text_is_generic() {
    let (_, json) = run(StatusCode::INTERNAL_SERVER_ERROR, false, "Service panicked");
    assert_eq!(json["error"]["code"], "internal");
    assert_eq!(json["error"]["message"], "internal server error");
}
// Split test sources are also read independently by the route census.
#[cfg(test)]
#[tokio::test]
async fn an_existing_reference_is_reused_and_localized_as_problem_json() {
    use axum::{Router, routing::get};
    use tower::ServiceExt;
    let config = crate::AppConfig::from_pairs(std::iter::empty::<(&str, &str)>()).unwrap();
    let state = crate::AppState::new(config, crate::DatabaseDependency::NotConfigured).unwrap();
    let reference = "0123456789abcdef0123456789abcdef";
    let app = Router::new().route("/failure", get(move || async move {
        (StatusCode::FORBIDDEN, axum::Json(json!({"error": {"code": "forbidden", "message": "forbidden", "support_ref": reference}})))
    })).layer(axum::middleware::from_fn_with_state(state, redact))
        .layer(axum::middleware::from_fn(crate::error_i18n::localize));
    let response = app
        .oneshot(
            Request::builder()
                .uri("/failure")
                .header("accept-language", "ko")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.headers()["support-ref"], reference);
    assert_eq!(response.headers()["content-language"], "ko");
    let body: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(body["error"]["support_ref"], reference);
    assert_ne!(body["error"]["message"], "forbidden");
    assert_eq!(body["title"], body["error"]["message"]);
}
