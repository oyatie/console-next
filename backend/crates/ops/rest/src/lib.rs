// SPDX-License-Identifier: LicenseRef-Proprietary
//! Stage-0 operator API and server-loaded authorization facts.
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::error_handling::HandleErrorLayer;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use console_ops_application::home::CockpitEvaluator;
use time::OffsetDateTime;
use tokio::sync::{Mutex, watch};
use tower::{BoxError, ServiceBuilder};
use tracing::Instrument;

use crate::origin_guard::{OriginGuardConfig, origin_guard};
use crate::state::OpsRestState;

pub mod access_jwt;
pub mod error;
pub mod handlers;
mod jwks_validate;
pub mod operators;
pub mod origin_guard;
pub mod sse;
pub mod state;

pub fn api_routes(state: OpsRestState) -> Router {
    Router::new()
        .route("/api/ops/v1/me", get(handlers::get_me))
        .route("/api/ops/v1/home", get(handlers::get_home))
        .route("/api/ops/v1/alerts", get(handlers::get_alerts))
        .route("/api/ops/v1/alerts/{key}", get(handlers::get_alert_detail))
        .route("/api/ops/v1/silences", get(handlers::get_silences))
        .route("/api/ops/v1/running", get(handlers::get_running))
        .route("/api/ops/v1/running/jobs", get(handlers::get_jobs))
        .route("/api/ops/v1/sources", get(handlers::get_sources))
        .with_state(state)
}

pub fn sse_routes(state: OpsRestState) -> Router {
    Router::new()
        .route("/api/ops/v1/events", get(sse::get_events))
        .with_state(state)
}

pub fn router(state: OpsRestState, request_timeout: Option<Duration>) -> Router {
    let support_ref = state.support_ref.clone();
    let json_router = match request_timeout {
        Some(timeout) => api_routes(state.clone()).layer(
            ServiceBuilder::new()
                .layer(HandleErrorLayer::new(move |err: BoxError| {
                    let sref = (support_ref)();
                    async move { timeout_response(err, sref) }
                }))
                .timeout(timeout),
        ),
        None => api_routes(state.clone()),
    };
    let guard_cfg = OriginGuardConfig {
        expected_origin: state.origin.clone(),
        support_ref: state.support_ref.clone(),
    };
    let support_ref_norm = state.support_ref.clone();
    json_router
        .merge(sse_routes(state))
        .layer(axum::middleware::from_fn_with_state(
            support_ref_norm,
            error::normalize_error_response,
        ))
        .layer(axum::middleware::from_fn_with_state(
            guard_cfg,
            origin_guard,
        ))
}

fn timeout_response(error: BoxError, support_ref: String) -> Response {
    tracing::warn!(error = %error, support_ref = %support_ref, "ops request timed out");
    let body = serde_json::json!({
        "evaluated_at": crate::error::format_utc_z(OffsetDateTime::now_utc()),
        "support_ref": support_ref,
        "code": "OPS_TIMEOUT",
        "message": "request timed out"
    });
    let mut resp = (StatusCode::SERVICE_UNAVAILABLE, axum::Json(body)).into_response();
    resp.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp
}

pub fn init_ops_metrics() {
    metrics::gauge!("ops_cockpit_evaluator_last_success_timestamp_seconds").set(0.0);
    metrics::gauge!("ops_cockpit_access_jwks_age_seconds").set(0.0);
    metrics::gauge!("ops_cockpit_sse_clients").set(0.0);
    metrics::counter!("ops_cockpit_sse_resyncs_total").absolute(0);
    metrics::describe_histogram!(
        "ops_cockpit_evaluator_duration_seconds",
        "Duration of ops cockpit evaluation cycles in seconds"
    );
    for outcome in ["success", "error"] {
        metrics::counter!("ops_cockpit_evaluator_runs_total", "outcome" => outcome).absolute(0);
        metrics::counter!("ops_cockpit_record_writes_total", "outcome" => outcome).absolute(0);
        metrics::counter!("ops_cockpit_record_verifications_total", "outcome" => outcome)
            .absolute(0);
    }
    for source in ["alertmanager", "vmalert", "victoriametrics", "access_jwks"] {
        metrics::gauge!("ops_cockpit_source_age_seconds", "source" => source).set(0.0);
        for outcome in ["success", "error"] {
            metrics::counter!(
                "ops_cockpit_source_reads_total",
                "source" => source,
                "outcome" => outcome
            )
            .absolute(0);
        }
    }
    for kind in [
        "home.changed",
        "alert.group.changed",
        "alert.group.resolved",
        "component.changed",
        "job.changed",
        "source.changed",
        "heartbeat",
        "resync",
    ] {
        metrics::counter!("ops_cockpit_sse_events_total", "type" => kind).absolute(0);
    }
    for action in [
        "read.me",
        "read.home",
        "read.alerts",
        "read.running",
        "read.sources",
    ] {
        for decision in ["allow", "deny"] {
            metrics::counter!(
                "ops_cockpit_authz_decisions_total",
                "action" => action,
                "decision" => decision
            )
            .absolute(0);
        }
    }
}

pub fn spawn_evaluator_loop(
    state: OpsRestState,
    evaluator: Arc<Mutex<CockpitEvaluator>>,
    eval_interval: Duration,
    mut shutdown: watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut eval_tick = tokio::time::interval(eval_interval);
        eval_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let jwks_period = Duration::from_secs(state.jwt.interval_s().get());
        let mut jwks_tick = tokio::time::interval(jwks_period);
        jwks_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                biased;
                changed = shutdown.changed() => {
                    if changed.is_err() || *shutdown.borrow() {
                        break;
                    }
                }
                _ = jwks_tick.tick() => {
                    let now = (state.clock)();
                    let outcome = match state.jwt.refresh(now).instrument(tracing::info_span!("ops.source.read", source = "access_jwks")).await {
                        Ok(()) => "success",
                        Err(err) => {
                            tracing::warn!(error = %err, "ops access jwks refresh failed");
                            "error"
                        }
                    };
                    metrics::counter!(
                        "ops_cockpit_source_reads_total",
                        "source" => "access_jwks",
                        "outcome" => outcome
                    )
                    .increment(1);
                    metrics::gauge!("ops_cockpit_access_jwks_age_seconds")
                        .set(state.jwt.jwks_age_seconds(now) as f64);
                }
                _ = eval_tick.tick() => {
                    let start = std::time::Instant::now();
                    state
                        .apply_evaluation(&evaluator)
                        .instrument(tracing::info_span!("ops.evaluator.run"))
                        .await;
                    metrics::histogram!("ops_cockpit_evaluator_duration_seconds")
                        .record(start.elapsed().as_secs_f64());
                }
            }
        }
    })
}
