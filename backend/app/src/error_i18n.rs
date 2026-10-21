//! Korean error messages for `Accept-Language: ko`.
//!
//! Every crate keeps emitting its English `{"error":{"code","message"}}`; this
//! outermost layer rewrites only `error.message` (never `code` or any other
//! field) when the caller prefers Korean, through the ONE message table,
//! [`korean_message`] (in `console_platform_request_context::error_i18n` since
//! R2 step 0; frozen, OD-8). English stays the default.
//!
//! It also localizes the server-authored org-change `reason` strings (the
//! legacy org-setup drafts) wherever they appear as a `reason` value in an
//! org-change response. Preflight blocker/warning labels are already Korean.

use axum::body::{Body, to_bytes};
use axum::extract::Request;
use axum::http::header;
use axum::middleware::Next;
use axum::response::Response;
pub(crate) use console_platform_request_context::error_i18n::{korean_message, prefers_korean};
use serde_json::Value;

/// Server-authored org-change `reason` strings (legacy org-setup drafts).
const REASONS: &[(&str, &str)] = &[
    (
        "Create region requested through the legacy org-setup API",
        "조직 설정 화면에서 지역 신설을 요청했습니다.",
    ),
    (
        "Rename region requested through the legacy org-setup API",
        "조직 설정 화면에서 지역 이름 변경을 요청했습니다.",
    ),
    (
        "Deactivate region requested through the legacy org-setup API",
        "조직 설정 화면에서 지역 비활성화를 요청했습니다.",
    ),
    (
        "Create branch requested through the legacy org-setup API",
        "조직 설정 화면에서 지점 신설을 요청했습니다.",
    ),
    (
        "Update branch requested through the legacy org-setup API",
        "조직 설정 화면에서 지점 변경을 요청했습니다.",
    ),
    (
        "Deactivate branch requested through the legacy org-setup API",
        "조직 설정 화면에서 지점 비활성화를 요청했습니다.",
    ),
];

fn lookup(table: &[(&str, &'static str)], key: &str) -> Option<&'static str> {
    table.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

fn localize_reasons(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                if key == "reason"
                    && let Value::String(text) = child
                    && let Some(ko) = lookup(REASONS, text)
                {
                    *text = ko.to_owned();
                } else {
                    localize_reasons(child);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(localize_reasons),
        _ => {}
    }
}

/// Per-item `error.refusals[]` of an all-or-nothing batch carry their own
/// `{code, message}`; each message goes through the same lookup as the
/// top-level one. `code` is never touched.
fn localize_refusals(error: &mut serde_json::Map<String, Value>) {
    let Some(Value::Array(items)) = error.get_mut("refusals") else {
        return;
    };
    for item in items.iter_mut().filter_map(Value::as_object_mut) {
        let code = item
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        if let Some(Value::String(message)) = item.get_mut("message") {
            *message = korean_message(&code, message);
        }
    }
}

/// Response bodies above this are passed through untouched.
const MAX_REWRITE_BYTES: usize = 4 * 1024 * 1024;

/// Buffer a response body of known size up to [`MAX_REWRITE_BYTES`] for a
/// rewriting layer. A larger or unsized body comes back untouched as `Err`
/// (never consumed and dropped); a body that fails to read becomes empty.
pub(crate) async fn buffer_small_body(
    response: Response,
) -> Result<(axum::http::response::Parts, axum::body::Bytes), Box<Response>> {
    if axum::body::HttpBody::size_hint(response.body())
        .upper()
        .is_none_or(|upper| upper > MAX_REWRITE_BYTES as u64)
    {
        return Err(Box::new(response));
    }
    let (parts, body) = response.into_parts();
    match to_bytes(body, MAX_REWRITE_BYTES).await {
        Ok(bytes) => Ok((parts, bytes)),
        Err(_) => Err(Box::new(Response::from_parts(parts, Body::empty()))),
    }
}

/// Outermost layer: rewrites JSON error messages (and org-change reasons) for
/// Korean-preferring callers. Everything else streams through unbuffered.
pub async fn localize(request: Request, next: Next) -> Response {
    let korean = prefers_korean(request.headers());
    let org_change = request.uri().path().starts_with("/api/v1/org-changes");
    let response = next.run(request).await;
    let is_json = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("application/json"));
    let is_error = response.status().is_client_error() || response.status().is_server_error();
    if !korean || !is_json || !(is_error || org_change) {
        return response;
    }
    let (mut parts, bytes) = match buffer_small_body(response).await {
        Ok(buffered) => buffered,
        Err(response) => return *response,
    };
    let Ok(mut json) = serde_json::from_slice::<Value>(&bytes) else {
        return Response::from_parts(parts, Body::from(bytes));
    };
    if let Some(error) = json.get_mut("error").and_then(Value::as_object_mut) {
        let code = error
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        if let Some(Value::String(message)) = error.get_mut("message") {
            *message = korean_message(&code, message);
        }
        localize_refusals(error);
    }
    if org_change {
        localize_reasons(&mut json);
    }
    let bytes = serde_json::to_vec(&json).unwrap_or_else(|_| bytes.to_vec());
    parts.headers.remove(header::CONTENT_LENGTH);
    parts.headers.insert(
        header::CONTENT_LANGUAGE,
        header::HeaderValue::from_static("ko"),
    );
    Response::from_parts(parts, Body::from(bytes))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn bulk_refusal_messages_use_the_same_table_and_keep_codes() {
        let mut json = serde_json::json!({"error": {
            "code": "bulk_lifecycle_refused",
            "refusals": [
                {"employee_id": "e1", "code": "lifecycle_signoff_required", "message": "payroll_cutoff_ack is required for TERMINATE"},
                {"employee_id": "e2", "code": "not_found", "message": "something new"}
            ]
        }});
        localize_refusals(json["error"].as_object_mut().unwrap());
        let refusals = &json["error"]["refusals"];
        assert_eq!(
            refusals[0]["message"],
            "TERMINATE 이벤트에는 급여 마감 확인(payroll_cutoff_ack)이 필요합니다."
        );
        assert_eq!(refusals[0]["code"], "lifecycle_signoff_required");
        assert_eq!(refusals[1]["message"], "대상을 찾을 수 없습니다.");
        assert_eq!(refusals[1]["employee_id"], "e2");
    }

    #[test]
    fn reasons_are_rewritten_only_under_reason_keys() {
        let mut json = serde_json::json!({
            "reason": "Create region requested through the legacy org-setup API",
            "events": [{"reason": "Deactivate branch requested through the legacy org-setup API"}],
            "label": "Create region requested through the legacy org-setup API"
        });
        localize_reasons(&mut json);
        assert_eq!(
            json["reason"],
            "조직 설정 화면에서 지역 신설을 요청했습니다."
        );
        assert_eq!(
            json["events"][0]["reason"],
            "조직 설정 화면에서 지점 비활성화를 요청했습니다."
        );
        assert_eq!(
            json["label"],
            "Create region requested through the legacy org-setup API"
        );
    }
}
