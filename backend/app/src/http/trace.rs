//! The request `TraceLayer`.

use crate::http::metrics::cardinality_safe_http_route;
use crate::telemetry::record_otel_ids;
use axum::body::Body;
use axum::http::{Request, Response};
use std::time::Duration;
use tower_http::trace::TraceLayer;

/// Build the `TraceLayer` applied to the fully-merged router so EVERY route
/// (base, domain, platform, realtime, auth) emits a request span. Tracing a
/// long-lived WS/SSE connection only logs its start/end, so this is safe to
/// apply even to the realtime route.
// The return type spells out the closure-parameterized `TraceLayer`; clippy's
// `type_complexity` lint fires on this builder-style signature, which is the
// idiomatic shape for a configured tower layer.
#[allow(clippy::type_complexity)]
pub(crate) fn http_trace_layer() -> TraceLayer<
    tower_http::classify::SharedClassifier<tower_http::classify::ServerErrorsAsFailures>,
    impl Fn(&Request<Body>) -> tracing::Span + Clone,
    impl Fn(&Request<Body>, &tracing::Span) + Clone,
    impl Fn(&Response<Body>, Duration, &tracing::Span) + Clone,
> {
    TraceLayer::new_for_http()
        .make_span_with(|request: &Request<Body>| {
            tracing::info_span!(
                "http.request",
                method = %request.method(),
                // Matched route template ONLY — never the raw path or query
                // string. A raw path can carry object IDs and a query can carry
                // PII (a search term, a name, a phone). `MatchedPath` gives the
                // stable template label the OTel/LGTM backend can safely index.
                http_route = %cardinality_safe_http_route(request),
                version = ?request.version(),
                trace_id = tracing::field::Empty,
                span_id = tracing::field::Empty,
            )
        })
        .on_request(|request: &Request<Body>, span: &tracing::Span| {
            let trace_id = record_otel_ids(span);
            tracing::info!(
                trace_id = %trace_id,
                method = %request.method(),
                // Matched route template only; see make_span_with.
                http_route = %cardinality_safe_http_route(request),
                "http request started"
            );
        })
        .on_response(
            |response: &Response<Body>, latency: Duration, span: &tracing::Span| {
                let trace_id = record_otel_ids(span);
                tracing::info!(
                    trace_id = %trace_id,
                    status = response.status().as_u16(),
                    latency_ms = latency.as_millis(),
                    "http request completed"
                );
            },
        )
}
