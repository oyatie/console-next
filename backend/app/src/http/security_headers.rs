// SPDX-License-Identifier: LicenseRef-Proprietary
//! Origin-level browser protections for every API response, including errors.

use axum::extract::Request;
use axum::http::{HeaderValue, header};
use axum::middleware::Next;
use axum::response::Response;

pub async fn api_security_headers(request: Request, next: Next) -> Response {
    let path = request.uri().path();
    let api = path == "/api" || path.starts_with("/api/");
    let mut response = next.run(request).await;
    if api {
        let headers = response.headers_mut();
        headers.insert(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        );
        // A separate policy preserves stricter handler policies: browsers enforce both.
        headers.append(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("frame-ancestors 'none'"),
        );
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, body::Body, http::Request, routing::get};
    use tower::ServiceExt;

    #[tokio::test]
    async fn api_headers_preserve_existing_csp_and_leave_other_routes_alone() {
        let app = Router::new()
            .route(
                "/api/v1/test",
                get(|| async {
                    (
                        [(header::CONTENT_SECURITY_POLICY, "default-src 'none'")],
                        "{}",
                    )
                }),
            )
            .route("/apiary", get(|| async { "ok" }))
            .layer(axum::middleware::from_fn(api_security_headers));
        let response = app
            .clone()
            .oneshot(Request::get("/api/v1/test").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(
            response.headers()[header::X_CONTENT_TYPE_OPTIONS],
            "nosniff"
        );
        let policies: Vec<_> = response
            .headers()
            .get_all(header::CONTENT_SECURITY_POLICY)
            .iter()
            .collect();
        assert_eq!(policies, ["default-src 'none'", "frame-ancestors 'none'"]);
        let response = app
            .oneshot(Request::get("/apiary").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(
            !response
                .headers()
                .contains_key(header::CONTENT_SECURITY_POLICY)
        );
        assert!(
            !response
                .headers()
                .contains_key(header::X_CONTENT_TYPE_OPTIONS)
        );
    }
}
