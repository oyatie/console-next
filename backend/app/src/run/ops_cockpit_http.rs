// SPDX-License-Identifier: LicenseRef-Proprietary
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use console_kernel_core::ErrorType;
use console_ops_rest::error::format_utc_z;
use console_ops_rest::origin_guard::{OriginGuardConfig, origin_guard};
use console_ops_rest::state::OpsRestState;
use serde::Serialize;
use serde_json::Value;
use time::OffsetDateTime;

use crate::config::AppConfig;
use crate::config::role::AppRole;
use crate::error_i18n::buffer_small_body;
use crate::http::cache_control::default_no_store;
use crate::http::metrics::{
    StaticRoute, cardinality_safe_http_route, record_http_duration, render_metrics_body,
};
use crate::http::security_headers::api_security_headers;
use crate::http::trace::http_trace_layer;
use crate::spa::{dist_etag, serve_spa, spa_csp};
use crate::telemetry::{current_trace_context, with_trace_context};

#[derive(Clone)]
pub(crate) struct OpsProbeState {
    pub(crate) service_name: String,
    pub(crate) ready: Arc<AtomicBool>,
    pub(crate) draining: Arc<AtomicBool>,
}

#[derive(Serialize)]
struct ProbeBody<'a> {
    status: &'a str,
    service: String,
    role: AppRole,
}

pub(crate) async fn ops_healthz(State(probe): State<OpsProbeState>) -> impl IntoResponse {
    axum::Json(ProbeBody {
        status: "ok",
        service: probe.service_name,
        role: AppRole::Ops,
    })
}

pub(crate) async fn ops_readyz(State(probe): State<OpsProbeState>) -> impl IntoResponse {
    let draining = probe.draining.load(Ordering::Relaxed);
    let ready = !draining && probe.ready.load(Ordering::Relaxed);
    let status = if ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    let label = if draining {
        "draining"
    } else if ready {
        "ready"
    } else {
        "not_ready"
    };
    (
        status,
        axum::Json(ProbeBody {
            status: label,
            service: probe.service_name,
            role: AppRole::Ops,
        }),
    )
}

pub(crate) fn ops_internal_router(probe: OpsProbeState) -> Router {
    Router::new()
        .route("/metrics", get(|| async { render_metrics_body() }))
        .route("/healthz", get(ops_healthz))
        .route("/readyz", get(ops_readyz))
        .with_state(probe)
}

pub fn build_ops_router(
    config: &AppConfig,
    ops_state: OpsRestState,
    ready: Arc<AtomicBool>,
    draining: Arc<AtomicBool>,
) -> Router {
    let probe = OpsProbeState {
        service_name: config.service_name.clone(),
        ready,
        draining,
    };
    let guard_cfg = OriginGuardConfig {
        expected_origin: ops_state.origin.clone(),
        support_ref: ops_state.support_ref.clone(),
    };
    let base = Router::new()
        .route("/healthz", get(ops_healthz))
        .route("/readyz", get(ops_readyz))
        .with_state(probe)
        .merge(console_ops_rest::router(
            ops_state,
            Some(config.request_timeout),
        ));

    let router = match config.web_dist.clone() {
        Some(dist) => {
            let hsts = config.cookie_secure;
            let dist: Arc<std::path::Path> = dist.into();
            let etag = dist_etag(&dist);
            let csp = spa_csp(None, None);
            base.fallback(move |request: Request<Body>| {
                serve_spa(dist.clone(), etag.clone(), hsts, csp.clone(), request)
            })
        }
        None => base,
    };

    let router = router
        .layer(axum::middleware::from_fn_with_state(
            guard_cfg,
            origin_guard,
        ))
        .layer(axum::extract::DefaultBodyLimit::max(
            crate::http::MAX_REQUEST_BODY_BYTES,
        ))
        .layer(tower_http::catch_panic::CatchPanicLayer::new())
        .layer(axum::middleware::from_fn(ops_error_normalizer))
        .layer(axum::middleware::from_fn(default_no_store))
        .layer(axum::middleware::from_fn(api_security_headers))
        .layer(http_trace_layer())
        .layer(axum::middleware::from_fn(with_trace_context));

    let router = console_platform_request_context::with_trusted_client_ip(
        router,
        config.trusted_proxy_count,
        config.trusted_proxy_cidrs.clone(),
    );
    with_ops_metrics(router, config.service_name.clone(), config.internal_addr)
}

fn with_ops_metrics(
    router: Router,
    service_name: String,
    internal_addr: Option<SocketAddr>,
) -> Router {
    let router = router.layer(axum::middleware::from_fn_with_state(
        service_name,
        track_ops_http_metrics,
    ));
    match internal_addr {
        Some(_) => router,
        None => router.route("/metrics", get(|| async { render_metrics_body() })),
    }
}

async fn track_ops_http_metrics(
    State(service_name): State<String>,
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
    let error_type = response.extensions().get::<ErrorType>().map_or("", |e| e.0);
    record_http_duration(
        &service_name,
        &method,
        &http_route,
        status,
        error_type,
        start.elapsed(),
    );
    response
}

async fn ops_error_normalizer(request: Request, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    let response = next.run(request).await;
    let status = response.status();
    if path == "/readyz" || !(status.is_client_error() || status.is_server_error()) {
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
    let (mut parts, bytes) = match buffer_small_body(response).await {
        Ok(ok) => ok,
        Err(resp) => return *resp,
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
    let support_ref = current_trace_context().trace_id().to_owned();
    let body = serde_json::json!({
        "evaluated_at": format_utc_z(OffsetDateTime::now_utc()),
        "support_ref": support_ref,
        "code": code,
        "message": message,
    });
    parts.headers.remove(header::CONTENT_LENGTH);
    parts.headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    parts
        .headers
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    let mut out = Response::from_parts(parts, Body::from(body.to_string()));
    out.extensions_mut().insert(ErrorType(code));
    out
}
