// SPDX-License-Identifier: LicenseRef-Proprietary
use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{HeaderName, HeaderValue, Method, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::error::OpsApiError;

#[derive(Clone)]
pub struct OriginGuardConfig {
    pub expected_origin: Arc<str>,
    pub support_ref: Arc<dyn Fn() -> String + Send + Sync>,
}

const SEC_FETCH_SITE: HeaderName = HeaderName::from_static("sec-fetch-site");

pub async fn origin_guard(
    State(cfg): State<OriginGuardConfig>,
    request: Request,
    next: Next,
) -> Response {
    if *request.method() != Method::GET && *request.method() != Method::HEAD {
        let origin_ok = request
            .headers()
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            == Some(cfg.expected_origin.as_ref());
        let fetch_site_ok = request
            .headers()
            .get(&SEC_FETCH_SITE)
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            == Some("same-origin");
        if !(origin_ok && fetch_site_ok) {
            let mut resp =
                OpsApiError::origin_refused((cfg.support_ref)(), "origin_guard").into_response();
            strip_cors_and_cookies(resp.headers_mut());
            return resp;
        }
    }

    let mut response = next.run(request).await;
    strip_cors_and_cookies(response.headers_mut());
    if response.headers().get(header::CACHE_CONTROL).is_none() {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
}

fn strip_cors_and_cookies(headers: &mut axum::http::HeaderMap) {
    let to_remove: Vec<HeaderName> = headers
        .keys()
        .filter(|name| {
            let lower = name.as_str();
            lower.starts_with("access-control-") || lower == "set-cookie"
        })
        .cloned()
        .collect();
    for name in to_remove {
        headers.remove(name);
    }
}
