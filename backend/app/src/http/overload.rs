//! Overload behaviour (R3): a request the process cannot serve now answers
//! `503 Service Unavailable` + `Retry-After`, never a 408 or a 500.
//!
//! * [`with_timeout`]: a handler past the request budget is dropped and
//!   answered 503 (RFC 9110 §15.5.9: 408 means the *client* was slow).
//! * [`with_load_shed`]: at most [`MAX_IN_FLIGHT`] requests run at once across
//!   every route it wraps; one more is refused at once instead of queueing
//!   behind a 6-connection pool. The semaphore is global, not per route
//!   (`Router::layer` clones the layer per route, so a plain
//!   `ConcurrencyLimitLayer` would give each route its own 64).

use std::time::Duration;

use axum::Router;
use axum::error_handling::HandleErrorLayer;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use tower::limit::GlobalConcurrencyLimitLayer;
use tower::{BoxError, ServiceBuilder};

/// In-flight requests the shed stack admits. The runtime pool holds 6
/// connections with a 3 s acquire, so 64 is ~10 queued per connection.
pub(crate) const MAX_IN_FLIGHT: usize = 64;

/// Seconds a client waits before retrying a 503.
pub(crate) const RETRY_AFTER_SECS: &str = "2";

/// The one 503 body: the shared error envelope, code `unavailable` (Korean via
/// `error_i18n`'s code table).
pub(crate) fn unavailable() -> Response {
    let mut response = (
        StatusCode::SERVICE_UNAVAILABLE,
        axum::Json(serde_json::json!({
            "error": {"code": "unavailable", "message": "service temporarily unavailable"}
        })),
    )
        .into_response();
    response.headers_mut().insert(
        header::RETRY_AFTER,
        HeaderValue::from_static(RETRY_AFTER_SECS),
    );
    response
}

// The only errors reaching here are tower's `Elapsed` and `Overloaded`: every
// axum route service is infallible.
async fn on_error(error: BoxError) -> Response {
    // Not a warning per request: under a shed storm that is one log line per
    // refusal, and the logging itself slows the process that is shedding.
    tracing::debug!(error = %error, "request shed with 503");
    unavailable()
}

/// Answer 503 + `Retry-After` when a request outlives `timeout`.
pub(crate) fn with_timeout(router: Router, timeout: Duration) -> Router {
    router.layer(
        ServiceBuilder::new()
            .layer(HandleErrorLayer::new(on_error))
            .timeout(timeout),
    )
}

/// Refuse (503 + `Retry-After`) a request beyond `max` in flight across every
/// route of `router`.
pub(crate) fn with_load_shed(router: Router, max: usize) -> Router {
    router.layer(
        ServiceBuilder::new()
            .layer(HandleErrorLayer::new(on_error))
            .load_shed()
            .layer(GlobalConcurrencyLimitLayer::new(max)),
    )
}

// Plain `#[cfg(test)]` first: the openapi_drift route walker skips exactly
// that item, so these test-only routes are not read as served routes.
#[cfg(test)]
#[cfg(not(feature = "test-postgres"))]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::get;
    use tower::ServiceExt;

    async fn slow() -> &'static str {
        tokio::time::sleep(Duration::from_millis(400)).await;
        "done"
    }

    async fn status_of(app: Router, uri: &str) -> (StatusCode, Option<String>) {
        let response = app
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let retry = response
            .headers()
            .get(header::RETRY_AFTER)
            .map(|v| v.to_str().unwrap().to_owned());
        (response.status(), retry)
    }

    #[tokio::test]
    async fn a_request_past_the_budget_is_503_with_retry_after() {
        let app = with_timeout(
            Router::new().route("/slow", get(slow)),
            Duration::from_millis(50),
        );
        assert_eq!(
            status_of(app, "/slow").await,
            (StatusCode::SERVICE_UNAVAILABLE, Some("2".to_owned()))
        );
    }

    #[tokio::test]
    async fn the_limit_is_shared_by_every_route_and_sheds_the_overflow() {
        let shed = with_load_shed(
            Router::new().route("/a", get(slow)).route("/b", get(slow)),
            1,
        );
        // Merged outside the shed stack, like `/readyz`: never refused.
        let app = shed.merge(Router::new().route("/readyz", get(|| async { "ok" })));
        let busy = tokio::spawn(status_of(app.clone(), "/a"));
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            status_of(app.clone(), "/b").await,
            (StatusCode::SERVICE_UNAVAILABLE, Some("2".to_owned())),
            "a second route shares the one in-flight slot"
        );
        assert_eq!(status_of(app.clone(), "/readyz").await.0, StatusCode::OK);
        assert_eq!(busy.await.unwrap().0, StatusCode::OK);
        assert_eq!(status_of(app, "/b").await.0, StatusCode::OK, "slot freed");
    }
}
