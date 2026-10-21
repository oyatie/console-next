use crate::conflict;
use axum::{
    body::{Body, to_bytes},
    response::{IntoResponse, Response},
};
use http::StatusCode;
use serde_json::{Value, json};
use uuid::Uuid;
// These existing endpoints deliberately use different initial/replay responses.
pub(super) fn replay_status(status: StatusCode, path: &str) -> StatusCode {
    if (status == StatusCode::ACCEPTED && path == "/api/v1/employees/lifecycle-events/bulk")
        || path == "/api/v1/legal-entities"
        || (path.starts_with("/api/v1/work-orders/") && path.ends_with("/settlement"))
        || (path.starts_with("/api/v1/support/tickets/") && path.ends_with("/acceptance"))
    {
        status
    } else {
        StatusCode::OK
    }
}
pub(super) fn replay(command: &str, status: Option<i16>, mut result: Value) -> Response {
    if let Some(fields) = result.as_object_mut()
        && (fields.contains_key("replayed")
            || command == "POST /api/v1/equipment-3r/rental-cases"
            || (command.starts_with("POST /api/v1/logistics/asns/")
                && command.ends_with("/receipts")))
    {
        fields.insert("replayed".into(), json!(true));
    }
    let location = if command == "POST /api/v1/employees/lifecycle-events/bulk [respond-async]" {
        result["id"]
            .as_str()
            .and_then(|id| Uuid::parse_str(id).ok())
            .map(|id| format!("/api/v1/employees/lifecycle-events/bulk/jobs/{id}"))
    } else {
        None
    };
    let status = status
        .and_then(|s| StatusCode::from_u16(s as u16).ok())
        .unwrap_or(StatusCode::OK);
    let mut response = (status, axum::Json(result)).into_response();
    if let Some(location) = location.and_then(|value| http::HeaderValue::from_str(&value).ok()) {
        response
            .headers_mut()
            .insert(http::header::LOCATION, location);
    }
    response
}
pub(crate) fn refusal(status: StatusCode, code: &str, id: Option<Uuid>) -> Response {
    (status,axum::Json(json!({"error":{"code":code,"message":code,"operation_id":id,"last_change":if status==StatusCode::CONFLICT { Some(conflict::redacted()) } else { None }}}))).into_response()
}
pub(super) fn with_operation(mut response: Response, id: Uuid) -> Response {
    if let Ok(value) = http::HeaderValue::from_str(&id.to_string()) {
        response.headers_mut().insert("operation-id", value);
    }
    response
}
pub(super) async fn patch_error(response: Response, name: &str, value: Value) -> Response {
    let (mut parts, body) = response.into_parts();
    let Ok(bytes) = to_bytes(body, 4 * 1024 * 1024).await else {
        return refusal(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable", None);
    };
    // A non-JSON client error (an extractor rejection, e.g. a wire enum refused) passes through
    // with its own text: the redact layer envelopes it by status, and the id is in `operation-id`.
    let Ok(mut json) = serde_json::from_slice::<Value>(&bytes) else {
        return Response::from_parts(parts, Body::from(bytes));
    };
    if let Some(object) = json.get_mut("error").and_then(Value::as_object_mut) {
        object.insert(name.into(), value);
    }
    parts.headers.remove(http::header::CONTENT_LENGTH);
    Response::from_parts(parts, Body::from(json.to_string()))
}
pub(super) async fn refusal_code(response: Response) -> (Response, String) {
    let (parts, body) = response.into_parts();
    match to_bytes(body, 4 * 1024 * 1024).await {
        Ok(bytes) => {
            let code = serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|v| {
                    v.get("error")
                        .and_then(|e| e.get("code"))
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .unwrap_or_else(|| "validation".into());
            (Response::from_parts(parts, Body::from(bytes)), code)
        }
        Err(_) => (
            refusal(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable", None),
            "service_unavailable".into(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Regression: a plain-text rejection was replaced by a fabricated `conflict` envelope, so a
    /// refused wire enum answered `validation` with a nested conflict body as its message.
    #[tokio::test]
    async fn a_non_json_client_error_keeps_its_own_body() {
        let rejection = Response::builder()
            .status(StatusCode::UNPROCESSABLE_ENTITY)
            .header(http::header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(Body::from("event_type: invalid enum value"))
            .unwrap();
        let patched = patch_error(rejection, "operation_id", json!("op-1")).await;
        assert_eq!(patched.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let bytes = to_bytes(patched.into_body(), 1024).await.unwrap();
        assert_eq!(&bytes[..], b"event_type: invalid enum value");

        let envelope = Response::builder()
            .status(StatusCode::CONFLICT)
            .body(Body::from(
                r#"{"error":{"code":"stale_revision","message":"m"}}"#,
            ))
            .unwrap();
        let patched = patch_error(envelope, "operation_id", json!("op-1")).await;
        let bytes = to_bytes(patched.into_body(), 1024).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            (
                body["error"]["code"].clone(),
                body["error"]["operation_id"].clone()
            ),
            (json!("stale_revision"), json!("op-1"))
        );
    }
    #[tokio::test]
    async fn replay_preserves_domain_status_flags_and_validated_job_location() {
        assert_eq!(
            replay_status(StatusCode::ACCEPTED, "/api/v1/period-locks/id/unlock"),
            StatusCode::OK
        );
        assert_eq!(
            replay_status(
                StatusCode::ACCEPTED,
                "/api/v1/employees/lifecycle-events/bulk"
            ),
            StatusCode::ACCEPTED
        );
        assert_eq!(
            replay_status(StatusCode::CREATED, "/api/v1/work-orders/id/settlement"),
            StatusCode::CREATED
        );
        assert_eq!(
            replay_status(StatusCode::CREATED, "/api/v1/support/tickets/id/acceptance"),
            StatusCode::CREATED
        );
        for command in [
            "POST /api/v1/equipment-3r/rental-cases",
            "POST /api/v1/logistics/asns/id/receipts",
        ] {
            let response = replay(command, Some(200), json!({"id":"record"}));
            let bytes = to_bytes(response.into_body(), 1024).await.unwrap();
            assert_eq!(
                serde_json::from_slice::<Value>(&bytes).unwrap()["replayed"],
                true
            );
        }
        let command = "POST /api/v1/employees/lifecycle-events/bulk [respond-async]";
        let id = Uuid::new_v4();
        let response = replay(command, Some(202), json!({"id":id}));
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        assert_eq!(
            response.headers()["location"],
            format!("/api/v1/employees/lifecycle-events/bulk/jobs/{id}")
        );
        assert!(
            !replay(
                command,
                Some(202),
                json!({"id":"invalid\r\nLocation: hostile"})
            )
            .headers()
            .contains_key("location")
        );
    }
}
