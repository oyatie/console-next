//! Error hygiene (R4, R23): no internal error text leaves the process.
//!
//! * A 5xx error envelope keeps its `error.code` (and any other field) but its
//!   `message` becomes a generic text per status, plus `error.trace_id`; the
//!   original text is logged inside the request span. One layer covers every
//!   `internal(err.to_string())` site in every crate. A JSON body that is not
//!   the envelope (`/readyz`'s dependency report) passes untouched.
//! * A `text/plain` error (an axum extractor rejection such as malformed JSON,
//!   or a panic) becomes the JSON envelope `{"error":{code,message}}`.
//! * A connection-pool timeout is overload, not a fault: 503 + `Retry-After`
//!   (no other 503 gets the header: "not configured" is not transient). It is
//!   seen by sqlx's text, or by a `with_*` database helper inside the request
//!   timing out (`watch_pool_timeouts`) where a crate answered an opaque 500.
//!
//! Mounted inside `error_i18n::localize`, so the Korean layer translates the
//! generic message by code.

use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::Response;
use serde_json::{Map, Value, json};

use crate::error_i18n::buffer_small_body;
use crate::http::overload::RETRY_AFTER_SECS;

// sqlx's `PoolTimedOut` reaches here only as text, through ~48
// per-crate `From<sqlx::Error>` impls; matching the Display text is the one
// place that sees them all. Upgrade path: a typed `DbError::Unavailable`.
const POOL_TIMED_OUT: &str = "pool timed out while waiting for an open connection";

/// The client-facing text for a 5xx status.
fn generic_message(status: StatusCode) -> &'static str {
    match status {
        StatusCode::BAD_GATEWAY => "an upstream service failed",
        StatusCode::SERVICE_UNAVAILABLE => "service temporarily unavailable",
        StatusCode::GATEWAY_TIMEOUT => "an upstream service timed out",
        _ => "internal server error",
    }
}

/// The envelope code for a plain-text error with no code of its own.
fn code_for(status: StatusCode) -> &'static str {
    match status {
        StatusCode::PAYLOAD_TOO_LARGE => "payload_too_large",
        StatusCode::UNSUPPORTED_MEDIA_TYPE => "unsupported_media_type",
        StatusCode::UNPROCESSABLE_ENTITY => "validation",
        StatusCode::METHOD_NOT_ALLOWED => "method_not_allowed",
        StatusCode::UNAUTHORIZED => "unauthorized",
        StatusCode::FORBIDDEN => "forbidden",
        StatusCode::NOT_FOUND => "not_found",
        StatusCode::TOO_MANY_REQUESTS => "too_many_requests",
        StatusCode::SERVICE_UNAVAILABLE => "unavailable",
        s if s.is_server_error() => "internal",
        _ => "bad_request",
    }
}

fn content_type(response: &Response) -> &str {
    response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
}

/// A rewritten error body; `retry` marks a pool timeout turned into 503.
struct Rewritten {
    status: StatusCode,
    body: Value,
    retry: bool,
}

/// Rewrite one error body (see the module docs). `None` leaves a JSON body
/// that is not the error envelope untouched (e.g. `/readyz`'s own 503 report).
/// `trace_id` is only called for a 5xx; `pool_timed_out` says the request
/// waited past the pool's acquire timeout.
fn rewrite(
    status: StatusCode,
    (json, pool_timed_out): (bool, bool),
    bytes: &[u8],
    trace_id: impl FnOnce() -> String,
) -> Option<Rewritten> {
    let mut error = if json {
        match serde_json::from_slice::<Value>(bytes) {
            Ok(Value::Object(mut body)) => match body.remove("error") {
                Some(Value::Object(error)) => error,
                _ => return None,
            },
            _ => return None,
        }
    } else {
        Map::new()
    };
    let original = match error.get("message").and_then(Value::as_str) {
        Some(message) => message.to_owned(),
        None if json => String::new(),
        None => String::from_utf8_lossy(bytes).trim().to_owned(),
    };
    let retry = status.is_server_error() && (pool_timed_out || original.contains(POOL_TIMED_OUT));
    let status = if retry {
        error.insert("code".into(), "unavailable".into());
        StatusCode::SERVICE_UNAVAILABLE
    } else {
        status
    };
    error
        .entry("code")
        .or_insert_with(|| code_for(status).into());
    let message = if status.is_server_error() {
        let trace_id = trace_id();
        let generic = generic_message(status);
        // Our own generic bodies (load shedding) are not logged again; a 503
        // is expected under load, so it is a warning, not an error.
        if original != generic {
            if status == StatusCode::SERVICE_UNAVAILABLE {
                tracing::warn!(status = 503, trace_id = %trace_id, detail = %original, "server error response redacted");
            } else {
                tracing::error!(status = status.as_u16(), trace_id = %trace_id, detail = %original, "server error response redacted");
            }
        }
        error.insert("trace_id".into(), trace_id.into());
        generic.to_owned()
    } else {
        original
    };
    error.insert("message".into(), message.into());
    Some(Rewritten {
        status,
        body: json!({ "error": error }),
        retry,
    })
}

/// The response layer; see the module docs.
pub async fn redact(request: Request, next: Next) -> Response {
    let (response, pool_timed_out) =
        console_platform_db::watch_pool_timeouts(next.run(request)).await;
    let status = response.status();
    let kind = content_type(&response);
    let json = kind.starts_with("application/json");
    let text = kind.starts_with("text/plain");
    if !((status.is_server_error() && (json || text)) || (status.is_client_error() && text)) {
        return response;
    }
    let (mut parts, bytes) = match buffer_small_body(response).await {
        Ok(buffered) => buffered,
        Err(response) => return *response,
    };
    let Some(rewritten) = rewrite(status, (json, pool_timed_out), &bytes, || {
        crate::telemetry::record_otel_ids(&tracing::Span::current())
    }) else {
        return Response::from_parts(parts, Body::from(bytes));
    };
    parts.status = rewritten.status;
    parts.headers.remove(header::CONTENT_LENGTH);
    parts.headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    // Only overload earns Retry-After: a "not configured" 503 is not transient.
    if rewritten.retry {
        parts.headers.insert(
            header::RETRY_AFTER,
            HeaderValue::from_static(RETRY_AFTER_SECS),
        );
    }
    Response::from_parts(parts, Body::from(rewritten.body.to_string()))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn run(status: StatusCode, json: bool, body: &str) -> (StatusCode, Value) {
        let rewritten =
            rewrite(status, (json, false), body.as_bytes(), || "t-1".to_owned()).unwrap();
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

    #[test]
    fn a_pool_timeout_is_a_503_unavailable() {
        let body = format!(
            r#"{{"error":{{"code":"internal","message":"database error: {POOL_TIMED_OUT}"}}}}"#
        );
        let (status, json) = run(StatusCode::INTERNAL_SERVER_ERROR, true, &body);
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(json["error"]["code"], "unavailable");
        assert_eq!(json["error"]["message"], "service temporarily unavailable");
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
        let pool = format!(r#"{{"error":{{"code":"internal","message":"{POOL_TIMED_OUT}"}}}}"#);
        let check = |body: &str| {
            rewrite(
                StatusCode::SERVICE_UNAVAILABLE,
                (true, false),
                body.as_bytes(),
                String::new,
            )
        };
        assert!(check(&pool).unwrap().retry);
        let unconfigured =
            r#"{"error":{"code":"service_unavailable","message":"x is not configured"}}"#;
        assert!(!check(unconfigured).unwrap().retry);
        // /readyz reports its dependencies in its own 503 body: not an envelope.
        assert!(check(r#"{"status":"not_ready","database":"unreachable"}"#).is_none());
    }

    #[test]
    fn a_panic_text_is_generic() {
        let (_, json) = run(StatusCode::INTERNAL_SERVER_ERROR, false, "Service panicked");
        assert_eq!(json["error"]["code"], "internal");
        assert_eq!(json["error"]["message"], "internal server error");
    }
}
