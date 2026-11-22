// SPDX-License-Identifier: LicenseRef-Proprietary
use axum::Json;
use axum::body::{Body, to_bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use console_kernel_core::ErrorType;
use serde::Serialize;
use serde_json::Value;
use time::{OffsetDateTime, UtcOffset, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::access_jwt::AccessJwtError;
use crate::operators::Refusal;
use crate::state::SupportRefFn;

#[derive(Debug)]
pub struct OpsApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub support_ref: String,
    pub operator_person: Option<Uuid>,
    pub route: &'static str,
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    evaluated_at: String,
    support_ref: &'a str,
    code: &'a str,
    message: &'a str,
}

impl OpsApiError {
    pub fn from_jwt(err: AccessJwtError, support_ref: String, route: &'static str) -> Self {
        let (code, message) = match err {
            AccessJwtError::Missing => {
                ("OPS_ACCESS_JWT_MISSING", "missing Cf-Access-Jwt-Assertion")
            }
            AccessJwtError::Invalid => ("OPS_ACCESS_JWT_INVALID", "invalid Cloudflare Access JWT"),
            AccessJwtError::AudMismatch => (
                "OPS_ACCESS_AUD_MISMATCH",
                "Cloudflare Access JWT audience mismatch",
            ),
        };
        Self {
            status: StatusCode::UNAUTHORIZED,
            code,
            message: message.to_owned(),
            support_ref,
            operator_person: None,
            route,
        }
    }

    pub fn from_refusal(
        refusal: Refusal,
        support_ref: String,
        route: &'static str,
        operator_person: Option<Uuid>,
    ) -> Self {
        let (code, message) = match refusal {
            Refusal::NotOperator => ("OPS_NOT_OPERATOR", "identity is not a registered operator"),
            Refusal::GrantNotLive => ("OPS_GRANT_NOT_LIVE", "operator has no live grant"),
            Refusal::ActionDenied => ("OPS_ACTION_DENIED", "operator lacks grant for action"),
        };
        Self {
            status: StatusCode::FORBIDDEN,
            code,
            message: message.to_owned(),
            support_ref,
            operator_person,
            route,
        }
    }

    pub fn origin_refused(support_ref: String, route: &'static str) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code: "origin_refused",
            message: "origin and fetch metadata check failed".to_owned(),
            support_ref,
            operator_person: None,
            route,
        }
    }

    pub fn not_found(support_ref: String, route: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: "OPS_NOT_FOUND",
            message: message.into(),
            support_ref,
            operator_person: None,
            route,
        }
    }

    pub fn bad_request(
        support_ref: String,
        route: &'static str,
        message: impl Into<String>,
    ) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "bad_request",
            message: message.into(),
            support_ref,
            operator_person: None,
            route,
        }
    }
}

pub async fn normalize_error_response(
    State(support_ref): State<SupportRefFn>,
    request: Request,
    next: Next,
) -> Response {
    let response = next.run(request).await;
    let status = response.status();
    if !(status.is_client_error() || status.is_server_error()) {
        return response;
    }
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let is_json_or_empty = content_type.is_empty()
        || content_type.starts_with("application/json")
        || content_type.starts_with("application/problem+json")
        || content_type.starts_with("text/plain");
    if !is_json_or_empty {
        return response;
    }
    let (mut parts, body) = response.into_parts();
    let Ok(bytes) = to_bytes(body, 64 * 1024).await else {
        return Response::from_parts(parts, Body::empty());
    };
    if let Ok(Value::Object(map)) = serde_json::from_slice::<Value>(&bytes)
        && map.contains_key("evaluated_at")
        && map.contains_key("support_ref")
        && map.contains_key("code")
        && map.contains_key("message")
    {
        return Response::from_parts(parts, Body::from(bytes));
    }

    let (code, message) = match status {
        StatusCode::NOT_FOUND => ("not_found", "no such route"),
        StatusCode::METHOD_NOT_ALLOWED => ("method_not_allowed", "method not allowed"),
        s if s.is_server_error() => ("internal", "internal server error"),
        _ => ("bad_request", "invalid request"),
    };
    let sref = (support_ref)();
    let payload = ErrorBody {
        evaluated_at: format_utc_z(OffsetDateTime::now_utc()),
        support_ref: &sref,
        code,
        message,
    };
    let serialized = serde_json::to_vec(&payload).unwrap_or_default();
    parts.headers.remove(header::CONTENT_LENGTH);
    parts.headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    parts
        .headers
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    let mut out = Response::from_parts(parts, Body::from(serialized));
    out.extensions_mut().insert(ErrorType(code));
    out
}

pub fn format_utc_z(ts: OffsetDateTime) -> String {
    ts.to_offset(UtcOffset::UTC)
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

impl IntoResponse for OpsApiError {
    fn into_response(self) -> Response {
        tracing::warn!(
            support_ref = %self.support_ref,
            code = self.code,
            status = self.status.as_u16(),
            route = self.route,
            operator_person = ?self.operator_person,
            "ops api refusal"
        );
        let body = ErrorBody {
            evaluated_at: format_utc_z(OffsetDateTime::now_utc()),
            support_ref: &self.support_ref,
            code: self.code,
            message: &self.message,
        };
        let mut response = (self.status, Json(body)).into_response();
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        response.extensions_mut().insert(ErrorType(self.code));
        response
    }
}
