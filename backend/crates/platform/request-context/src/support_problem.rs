// SPDX-License-Identifier: LicenseRef-Proprietary
//! Support refusals include authentication and extractor failures, before handlers run.
use axum::{
    Json, Router,
    body::to_bytes,
    extract::Request,
    middleware::Next,
    response::{IntoResponse, Response},
};
use console_platform_db::support::SupportError;
use http::{StatusCode, header};
use serde_json::{Value, json};

pub fn refusal(error: &SupportError) -> Response {
    if error.status() >= 500 {
        tracing::error!(%error,"support access failed closed");
    }
    problem(
        StatusCode::from_u16(error.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        error.code(),
    )
}

fn problem(status: StatusCode, code: &'static str) -> Response {
    let mut response=(status,Json(json!({"type":format!("urn:console:problem:{code}"),"title":code,"status":status.as_u16(),"detail":code,"code":code,"error":{"code":code,"message":code}}))).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        http::HeaderValue::from_static("application/problem+json"),
    );
    response
        .extensions_mut()
        .insert(console_kernel_core::ErrorType(code));
    response
}

pub fn with_support_problem_details<S: Clone + Send + Sync + 'static>(
    router: Router<S>,
) -> Router<S> {
    router.layer(axum::middleware::from_fn(
        |request: Request, next: Next| async move {
            let path = request.uri().path();
            let support = ["/api/platform/support-sessions", "/api/v1/support-sessions"]
                .iter()
                .any(|prefix| {
                    path == *prefix
                        || path
                            .strip_prefix(prefix)
                            .is_some_and(|rest| rest.starts_with('/'))
                });
            let response = next.run(request).await;
            if !support
                || !response.status().is_client_error() && !response.status().is_server_error()
                || response
                    .headers()
                    .get(header::CONTENT_TYPE)
                    .is_some_and(|v| v == "application/problem+json")
            {
                return response;
            }
            let status = response.status();
            let fallback = match status {
                StatusCode::UNAUTHORIZED => "unauthorized",
                StatusCode::FORBIDDEN => "forbidden",
                StatusCode::NOT_FOUND => "not_found",
                StatusCode::CONFLICT => "conflict",
                StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY => "validation",
                StatusCode::SERVICE_UNAVAILABLE => "unavailable",
                _ => "internal",
            };
            let bytes = to_bytes(response.into_body(), usize::MAX).await;
            let body = bytes
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
            let code = match body.as_ref().and_then(|v| v["error"]["code"].as_str()) {
                Some("unauthorized") => "unauthorized",
                Some("forbidden") => "forbidden",
                Some("validation") => "validation",
                Some("conflict") => "conflict",
                Some("not_found") => "not_found",
                Some("unavailable") => "unavailable",
                _ => fallback,
            };
            problem(status, code)
        },
    ))
}
