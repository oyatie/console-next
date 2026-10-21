//! Prometheus request metrics and the `/metrics` endpoint.

use crate::error::AppError;
use crate::state::AppState;
use axum::Router;
use axum::body::Body;
use axum::extract::{MatchedPath, State};
use axum::http::{Request, Response, StatusCode, header};
use axum::middleware::Next;
use axum::response::IntoResponse;
use axum::routing::get;
use console_kernel_core::ErrorType;
use metrics_exporter_prometheus::{Matcher, PrometheusBuilder, PrometheusHandle};
use std::sync::{Mutex, OnceLock};

/// Histogram name backing the OpenSLO availability + latency objectives
/// (`backend/app/slos/*.openslo.yaml`). The `metrics-exporter-prometheus`
/// renderer appends the standard `_bucket` / `_sum` / `_count` suffixes, and the
/// `s` unit suffix is already in the name, so the SLO queries
/// (`http_server_request_duration_seconds_bucket`,
/// `http_server_request_duration_seconds_count`) resolve against it directly.
const HTTP_DURATION_METRIC: &str = "http_server_request_duration_seconds";
const HTTP_ROUTE_UNMATCHED: &str = "/_unmatched";

/// Latency histogram boundaries in SECONDS. Chosen to bracket the 500ms p99 SLO
/// objective with resolution on either side.
const HTTP_LATENCY_BUCKETS: &[f64] = &[
    0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 10.0,
];

static METRICS_HANDLE: OnceLock<PrometheusHandle> = OnceLock::new();
// Serializes concurrent installers so at most one thread ever calls
// `PrometheusBuilder::install_recorder()`. Without this, two threads racing
// the `METRICS_HANDLE.get()` fast-path miss can both reach `install_recorder`;
// the `metrics` crate's own global recorder slot rejects the loser, and the
// loser's fallback read of `METRICS_HANDLE` can still be empty (the winner
// hasn't written it yet) -- a genuine TOCTOU window that surfaced as a flaky
// "metrics recorder installs once" panic under parallel #[tokio::test]s.
static METRICS_INSTALL_LOCK: Mutex<()> = Mutex::new(());

/// Install the process-global Prometheus recorder once and return a render
/// handle. Idempotent: the first successful install wins and later calls (and a
/// lost install race) return that same handle. Call at startup before serving.
pub fn install_metrics_recorder() -> Result<PrometheusHandle, AppError> {
    if let Some(handle) = METRICS_HANDLE.get() {
        return Ok(handle.clone());
    }
    let _guard = METRICS_INSTALL_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // Re-check now that we hold the lock: another thread may have finished
    // installing while we were waiting for it.
    if let Some(handle) = METRICS_HANDLE.get() {
        return Ok(handle.clone());
    }
    match PrometheusBuilder::new()
        .set_buckets_for_metric(
            Matcher::Full(HTTP_DURATION_METRIC.to_owned()),
            HTTP_LATENCY_BUCKETS,
        )
        .and_then(PrometheusBuilder::install_recorder)
    {
        Ok(handle) => Ok(METRICS_HANDLE.get_or_init(|| handle).clone()),
        // Lost the install race against a caller outside this lock (e.g. a
        // non-console-app global installer in the same process) -- adopt the
        // winner's handle; only a genuine absence is an error.
        Err(err) => METRICS_HANDLE
            .get()
            .cloned()
            .ok_or_else(|| AppError::Telemetry(err.to_string())),
    }
}

/// Cardinality-safe route label for request metrics/traces.
///
/// An adjacent Oyatie implementation, `oya-http-wide-event-middleware-infrastructure`,
/// was evaluated as reusable source material, but that crate depends on Oyatie-only
/// tenancy and hyperscaler metrics kernels. This app already owns the portable OTLP exporter
/// and Prometheus recorder in this module, so this lane intentionally copies the
/// discipline rather than wiring the oyatie crate directly: use axum's matched
/// route template (`MatchedPath`) as the route label, never the raw URI path or
/// query string. The sentinel keeps unmatched/error paths bounded too.
pub(crate) fn cardinality_safe_http_route<B>(request: &Request<B>) -> &str {
    request
        .extensions()
        .get::<MatchedPath>()
        .map(MatchedPath::as_str)
        .unwrap_or(HTTP_ROUTE_UNMATCHED)
}

/// The `http_route` label of a response the SPA fallback served (no matched
/// route): `/assets/*` for the hashed bundles, `/` for the rest (B-02).
#[derive(Clone, Copy)]
pub(crate) struct StaticRoute(pub(crate) &'static str);

/// Middleware: time each request and record its duration (seconds) into the
/// `http_server_request_duration_seconds` histogram, labelled with the service
/// name, method, response status code, and MATCHED ROUTE TEMPLATE. Labels stay
/// bounded because `http_route` comes from axum's `MatchedPath` extension (e.g.
/// `/api/work-orders/{id}`) or the static `/_unmatched` sentinel — never from the
/// raw URL path or query string. A no-op until the recorder is installed.
async fn track_http_metrics(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response<Body> {
    let start = std::time::Instant::now();
    let method = request.method().as_str().to_owned();
    let matched = cardinality_safe_http_route(&request).to_owned();
    let response = next.run(request).await;
    let http_route = response
        .extensions()
        .get::<StaticRoute>()
        .map_or(matched, |label| label.0.to_owned());
    let status = response.status().as_u16();
    // A refused response's stable code (OTel `error.type`), so an SLI can leave out the expected ones.
    let error_type = response.extensions().get::<ErrorType>().map_or("", |e| e.0);
    let elapsed = start.elapsed();
    let service_name = state.config.service_name.clone();
    metrics::histogram!(
        HTTP_DURATION_METRIC,
        "service_name" => service_name.clone(),
        "http_request_method" => method.clone(),
        "http_route" => http_route.clone(),
        "http_response_status_code" => status.to_string(),
        "error_type" => error_type,
    )
    .record(elapsed.as_secs_f64());
    tracing::info!(
        service_name = %service_name,
        http_request_method = %method,
        http_route = %http_route,
        http_response_status_code = status,
        error_type,
        latency_ms = elapsed.as_millis(),
        "http request wide event"
    );
    response
}

/// `GET /metrics` â Prometheus exposition. Internal-only: the ingress routes
/// `/api` to this server and everything else to the SPA, so `/metrics` is
/// reachable only in-cluster (e.g. by a ServiceMonitor scrape), never via the
/// public host.
async fn render_metrics() -> Response<Body> {
    match METRICS_HANDLE.get() {
        Some(handle) => (
            [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
            handle.render(),
        )
            .into_response(),
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            "metrics recorder not installed",
        )
            .into_response(),
    }
}

/// Wrap a fully-merged router with request metrics and expose `/metrics`. Applied
/// last so every route (base + all domain routers) is measured; `/metrics` is
/// added afterwards so it does not measure itself. Use `Router::layer` rather
/// than `route_layer` so the default 404 fallback is measured too; axum still
/// inserts `MatchedPath` before calling matched route endpoints, while unmatched
/// fallback requests use the bounded sentinel.
pub(crate) fn with_metrics(router: Router, state: &AppState) -> Router {
    let router = router.layer(axum::middleware::from_fn_with_state(
        state.clone(),
        track_http_metrics,
    ));
    match state.config.internal_addr {
        // P4: scraped on the internal listener only.
        Some(_) => router,
        None => router.route("/metrics", get(render_metrics)),
    }
}

/// P4: the `CONSOLE_INTERNAL_ADDR` listener's router: metrics and health,
/// for the scraper and the host only (never published through the tunnel).
pub(crate) fn internal_router(state: &AppState) -> Router {
    Router::new()
        .route("/metrics", get(render_metrics))
        .route("/healthz", get(crate::http::ops::healthz))
        .route("/readyz", get(crate::http::ops::readyz))
        .with_state(state.clone())
}

#[cfg(test)]
#[cfg(not(feature = "test-postgres"))]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod wide_event_middleware_tests {
    use axum::body::{Body, to_bytes};
    use axum::routing::get;
    use http::Request;
    use tower::ServiceExt;

    use super::install_metrics_recorder;
    use crate::config::AppConfig;
    use crate::config::role::AppRole;
    use crate::state::AppState;
    use crate::state::DatabaseDependency;

    #[tokio::test]
    async fn http_metrics_label_matched_route_template_not_raw_path() {
        install_metrics_recorder().expect("metrics recorder installs once");
        let config = AppConfig::from_pairs([
            ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
            ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
            ("CONSOLE_SERVICE_NAME", "console-wide-event-test".to_owned()),
        ])
        .expect("valid app config");
        let state = AppState::new(config, DatabaseDependency::NotConfigured)
            .expect("test state builds without database");
        let app = super::with_metrics(
            axum::Router::new()
                .route("/__wide_event/widgets/{widget_id}", get(|| async { "ok" }))
                .with_state(state.clone()),
            &state,
        );

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/__wide_event/widgets/widget-123?search=secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(response.status().is_success());

        let metrics = app
            .oneshot(
                Request::builder()
                    .uri("/metrics")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let text = String::from_utf8(
            to_bytes(metrics.into_body(), usize::MAX)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();

        assert!(
            text.contains("service_name=\"console-wide-event-test\"")
                && text.contains("http_route=\"/__wide_event/widgets/{widget_id}\""),
            "wide-event metrics must label the matched route template, not the raw request path; got:\n{text}"
        );
        assert!(
            !text.contains("widget-123") && !text.contains("search=secret"),
            "wide-event metrics must not leak raw path params or query strings; got:\n{text}"
        );
    }

    #[tokio::test]
    async fn http_metrics_label_unmatched_route_sentinel_not_raw_path() {
        install_metrics_recorder().expect("metrics recorder installs once");
        let config = AppConfig::from_pairs([
            ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
            ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
            (
                "CONSOLE_SERVICE_NAME",
                "console-wide-event-unmatched-test".to_owned(),
            ),
        ])
        .expect("valid app config");
        let state = AppState::new(config, DatabaseDependency::NotConfigured)
            .expect("test state builds without database");
        let app = super::with_metrics(
            axum::Router::new()
                .route("/__wide_event/known", get(|| async { "ok" }))
                .route(
                    "/__wide_event/expired",
                    get(|| async {
                        let tag = axum::Extension(console_kernel_core::ErrorType("token_expired"));
                        (http::StatusCode::UNAUTHORIZED, tag)
                    }),
                )
                .with_state(state.clone()),
            &state,
        );

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/__wide_event/missing/account-999?token=secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), http::StatusCode::NOT_FOUND);
        let expired = Request::builder()
            .uri("/__wide_event/expired")
            .body(Body::empty())
            .unwrap();
        app.clone().oneshot(expired).await.unwrap();

        let metrics = app
            .oneshot(
                Request::builder()
                    .uri("/metrics")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let text = String::from_utf8(
            to_bytes(metrics.into_body(), usize::MAX)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();

        assert!(
            text.contains("service_name=\"console-wide-event-unmatched-test\"")
                && text.contains("http_route=\"/_unmatched\"")
                && text.contains("http_response_status_code=\"404\"")
                && text.contains("http_response_status_code=\"401\",error_type=\"token_expired\""),
            "unmatched wide-event metrics must use the bounded sentinel; got:\n{text}"
        );
        assert!(
            !text.contains("/__wide_event/missing")
                && !text.contains("account-999")
                && !text.contains("token=secret"),
            "unmatched wide-event metrics must not leak raw paths or query strings; got:\n{text}"
        );
    }
}
