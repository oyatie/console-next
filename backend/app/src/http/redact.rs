//! Error hygiene (R4, R23): no internal error text leaves the process.
//!
//! * A 5xx error envelope keeps its `error.code` (and any other field) but its
//!   `message` becomes a generic text per status, plus `error.trace_id`; the
//!   original text is logged inside the request span. One layer covers every
//!   `internal(err.to_string())` site in every crate. A JSON body that is not
//!   the envelope (`/readyz`'s dependency report) passes untouched.
//! * A `text/plain` error (an axum extractor rejection such as malformed JSON,
//!   or a panic) becomes the JSON envelope `{"error":{code,message}}`.
//! * A typed connection-pool timeout is overload, not a fault: 503 + `Retry-After`
//!   (no other 503 gets the header: "not configured" is not transient). It is
//!   seen by a database helper inside the request timing out
//!   (`watch_pool_timeouts`) where a crate answered an opaque 500.
//!
//! Mounted inside `error_i18n::localize`, so the Korean layer translates the
//! generic message by code.

use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::Response;
use serde_json::{Map, Value};

use crate::error_i18n::buffer_small_body;
use crate::http::overload::RETRY_AFTER_SECS;

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
    let mut envelope = Map::new();
    let mut error = if json {
        match serde_json::from_slice::<Value>(bytes) {
            Ok(Value::Object(mut body)) => match body.remove("error") {
                Some(Value::Object(error)) => {
                    if status.is_client_error() {
                        envelope = body;
                    }
                    error
                }
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
    let retry = status.is_server_error() && pool_timed_out;
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
        error.entry("trace_id").or_insert_with(|| trace_id.into());
        generic.to_owned()
    } else {
        original
    };
    error.insert("message".into(), message.into());
    envelope.insert("error".into(), Value::Object(error));
    Some(Rewritten {
        status,
        body: Value::Object(envelope),
        retry,
    })
}

/// The response layer; see the module docs.
pub async fn redact(
    axum::extract::State(state): axum::extract::State<crate::state::AppState>,
    request: Request,
    next: Next,
) -> Response {
    let authorization = request.headers().get(header::AUTHORIZATION).cloned();
    let route = super::metrics::cardinality_safe_http_route(&request).to_owned();
    let (response, pool_timed_out) =
        console_platform_db::watch_pool_timeouts(next.run(request)).await;
    let status = response.status();
    let kind = content_type(&response);
    let json = kind.starts_with("application/json") || kind.starts_with("application/problem+json");
    let text = kind.starts_with("text/plain");
    if !((status.is_server_error() || status.is_client_error()) && (json || text)) {
        return response;
    }
    let (mut parts, bytes) = match buffer_small_body(response).await {
        Ok(buffered) => buffered,
        Err(response) => return *response,
    };
    let Some(mut rewritten) = rewrite(status, (json, pool_timed_out), &bytes, || {
        crate::telemetry::record_otel_ids(&tracing::Span::current())
    }) else {
        return Response::from_parts(parts, Body::from(bytes));
    };
    let trace_id = rewritten.body["error"]["trace_id"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| crate::telemetry::record_otel_ids(&tracing::Span::current()));
    rewritten.body["error"]["trace_id"] = trace_id.clone().into();
    let org = super::support_reference::request_org(&state, authorization.as_ref());
    let reference = rewritten.body["error"]["support_ref"]
        .as_str()
        .unwrap_or(&trace_id)
        .to_owned();
    let at = super::support_reference::issue(
        org,
        &route,
        &state.web_release,
        &reference,
        &trace_id,
        "http",
        None,
    );
    rewritten.body["error"]["support_ref"] = reference.clone().into();
    rewritten.body["error"]["support_ref_at"] = at.into();
    if let Ok(value) = HeaderValue::from_str(&reference) {
        parts.headers.insert("support-ref", value);
    }
    rewritten.body["type"] = "about:blank".into();
    rewritten.body["title"] = rewritten.body["error"]["message"].clone();
    rewritten.body["status"] = rewritten.status.as_u16().into();
    parts.status = rewritten.status;
    parts.headers.remove(header::CONTENT_LENGTH);
    parts.headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/problem+json"),
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
#[path = "redact_tests.rs"]
mod tests;
