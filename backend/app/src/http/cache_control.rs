//! INF-01: CACHE-1 enforced by a default layer.
//!
//! Every `/api` response that leaves its handler without a `Cache-Control`
//! header gets `no-store`: API JSON carries personal data and staff share PCs,
//! so nothing may sit in the browser cache (lane corrections #1, 2026-10-04;
//! supersedes the earlier `private, no-cache` default). A handler that sets its
//! own value keeps it, except a file download (`Content-Disposition:
//! attachment`, e.g. the employee CSV export), which always leaves as
//! `private, no-store` whatever its handler set. Cloudflare caches none of
//! `private`/`no-store`; the edge Cache Rule stays as defence in depth.
//!
//! Layered in `routes::build_router` on the fully merged router, next to
//! `error_i18n::localize`.

use axum::extract::Request;
use axum::http::{HeaderValue, header};
use axum::middleware::Next;
use axum::response::Response;

const API_PREFIX: &str = "/api/";

pub async fn default_no_store(request: Request, next: Next) -> Response {
    let api = request.uri().path().starts_with(API_PREFIX);
    let mut response = next.run(request).await;
    if !api {
        return response;
    }
    let headers = response.headers_mut();
    let download = headers
        .get(header::CONTENT_DISPOSITION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .trim_start()
                .get(..10)
                .is_some_and(|kind| kind.eq_ignore_ascii_case("attachment"))
        });
    if download {
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-store"),
        );
    } else {
        headers
            .entry(header::CACHE_CONTROL)
            .or_insert(HeaderValue::from_static("no-store"));
    }
    response
}

#[cfg(test)]
mod tests {
    use axum::Router;
    use axum::body::Body;
    use axum::http::{Request, header};
    use axum::routing::get;
    use tower::ServiceExt;

    use super::default_no_store;

    fn router() -> Router {
        Router::new()
            .route("/api/v1/plain", get(|| async { "{}" }))
            .route(
                "/api/v1/own",
                get(|| async { ([(header::CACHE_CONTROL, "private, max-age=60")], "{}") }),
            )
            .route(
                "/api/v1/export.csv",
                get(|| async {
                    (
                        [
                            (header::CACHE_CONTROL, "private, max-age=60"),
                            (
                                header::CONTENT_DISPOSITION,
                                "Attachment; filename=\"e.csv\"",
                            ),
                        ],
                        "a,b",
                    )
                }),
            )
            .route(
                "/api/v1/plain-download",
                get(|| async { ([(header::CONTENT_DISPOSITION, "attachment")], "a,b") }),
            )
            .route(
                "/api/v1/inline",
                get(|| async { ([(header::CONTENT_DISPOSITION, "inline")], "{}") }),
            )
            .route("/healthz", get(|| async { "ok" }))
            .fallback(|| async { (axum::http::StatusCode::NOT_FOUND, "{}") })
            .layer(axum::middleware::from_fn(default_no_store))
    }

    async fn cache_control(path: &str) -> Option<String> {
        let response = router()
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        response
            .headers()
            .get(header::CACHE_CONTROL)
            .map(|value| value.to_str().unwrap().to_owned())
    }

    #[tokio::test]
    async fn api_response_without_a_header_gets_no_store() {
        assert_eq!(
            cache_control("/api/v1/plain").await.as_deref(),
            Some("no-store")
        );
        assert_eq!(
            cache_control("/api/v1/inline").await.as_deref(),
            Some("no-store")
        );
    }

    #[tokio::test]
    async fn api_error_responses_get_no_store_too() {
        assert_eq!(
            cache_control("/api/v1/missing").await.as_deref(),
            Some("no-store")
        );
    }

    #[tokio::test]
    async fn a_handler_set_header_is_kept() {
        assert_eq!(
            cache_control("/api/v1/own").await.as_deref(),
            Some("private, max-age=60")
        );
    }

    #[tokio::test]
    async fn downloads_always_leave_private_no_store() {
        assert_eq!(
            cache_control("/api/v1/export.csv").await.as_deref(),
            Some("private, no-store")
        );
        assert_eq!(
            cache_control("/api/v1/plain-download").await.as_deref(),
            Some("private, no-store")
        );
    }

    #[tokio::test]
    async fn non_api_paths_are_untouched() {
        assert_eq!(cache_control("/healthz").await, None);
        assert_eq!(cache_control("/apiary").await, None);
    }
}
