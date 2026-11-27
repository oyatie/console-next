// SPDX-License-Identifier: LicenseRef-Proprietary
//! Operator cockpit API and server-loaded authorization facts.
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::error_handling::HandleErrorLayer;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use console_ops_application::home::CockpitEvaluator;
use time::OffsetDateTime;
use tokio::sync::{Mutex, watch};
use tower::{BoxError, ServiceBuilder};
use tracing::Instrument;

use crate::origin_guard::{OriginGuardConfig, origin_guard};
use crate::state::OpsRestState;

pub mod access_jwt;
pub mod backends;
pub mod error;
mod error_ops;
pub mod handlers;
pub mod handlers_alerts;
pub mod handlers_changes;
mod handlers_common;
pub mod handlers_incident_events;
pub mod handlers_incidents;
pub mod handlers_obligation_writes;
pub mod handlers_obligations;
pub mod handlers_ops;
pub mod handlers_promote;
pub mod handlers_recovery;
pub mod handlers_silences;
mod jwks_validate;
pub mod operators;
mod operators_shift;
mod ops_metrics;
pub mod origin_guard;
pub mod sse;
pub mod state;
mod valid_actions;

pub use backends::{FsBackendPaths, attach_fs_backends, validate_runbooks_dir};
pub use ops_metrics::init_ops_metrics;

pub fn api_routes(state: OpsRestState) -> Router {
    Router::new()
        .route("/api/ops/v1/me", get(handlers::get_me))
        .route("/api/ops/v1/home", get(handlers::get_home))
        .route("/api/ops/v1/alerts", get(handlers::get_alerts))
        .route("/api/ops/v1/alerts/{key}", get(handlers::get_alert_detail))
        .route(
            "/api/ops/v1/alerts/{key}/ack",
            post(handlers_alerts::ack_alert),
        )
        .route(
            "/api/ops/v1/silences",
            get(handlers::get_silences).post(handlers_silences::create_silence),
        )
        .route(
            "/api/ops/v1/silences/{id}",
            delete(handlers_silences::delete_silence),
        )
        .route("/api/ops/v1/oncall", get(handlers_ops::get_oncall))
        .route(
            "/api/ops/v1/oncall/page-test",
            post(handlers_ops::request_page_test),
        )
        .route("/api/ops/v1/running", get(handlers::get_running))
        .route("/api/ops/v1/running/jobs", get(handlers::get_jobs))
        .route(
            "/api/ops/v1/running/jobs/{name}/rerun",
            post(handlers_ops::rerun_job),
        )
        .route("/api/ops/v1/sources", get(handlers::get_sources))
        .route("/api/ops/v1/health", get(handlers_ops::get_health))
        .route(
            "/api/ops/v1/incidents",
            get(handlers_incidents::list_incidents).post(handlers_incidents::declare_incident),
        )
        .route(
            "/api/ops/v1/incidents/{id}",
            get(handlers_incidents::incident_detail),
        )
        .route(
            "/api/ops/v1/incidents/{id}/events",
            post(handlers_incident_events::record_incident_event),
        )
        .route(
            "/api/ops/v1/incidents/{id}/public-draft",
            post(handlers_incident_events::draft_public_update),
        )
        .route("/api/ops/v1/changes", get(handlers_changes::get_changes))
        .route(
            "/api/ops/v1/changes/rollback",
            post(handlers_changes::request_rollback),
        )
        .route(
            "/api/ops/v1/changes/canary",
            post(handlers_changes::request_canary),
        )
        .route(
            "/api/ops/v1/changes/freeze",
            post(handlers_changes::request_freeze),
        )
        .route("/api/ops/v1/promote", get(handlers_promote::get_promote))
        .route(
            "/api/ops/v1/promote/signoff",
            post(handlers_promote::signoff_promote),
        )
        .route(
            "/api/ops/v1/promote/feedback",
            post(handlers_promote::triage_feedback),
        )
        .route(
            "/api/ops/v1/promote/request",
            post(handlers_promote::request_promote),
        )
        .route("/api/ops/v1/recovery", get(handlers_recovery::get_recovery))
        .route(
            "/api/ops/v1/recovery/backup",
            post(handlers_recovery::request_backup),
        )
        .route(
            "/api/ops/v1/recovery/drill",
            post(handlers_recovery::request_drill),
        )
        .route("/api/ops/v1/actions", get(handlers_ops::list_actions))
        .route(
            "/api/ops/v1/runbooks",
            get(handlers_recovery::list_runbooks),
        )
        .route(
            "/api/ops/v1/runbooks/{*path}",
            get(handlers_recovery::read_runbook),
        )
        .route(
            "/api/ops/v1/obligations",
            get(handlers_obligations::list_obligations)
                .post(handlers_obligation_writes::open_obligation),
        )
        .route(
            "/api/ops/v1/obligations/{id}",
            get(handlers_obligations::obligation_detail),
        )
        .route(
            "/api/ops/v1/obligations/{id}/events",
            post(handlers_obligation_writes::record_obligation_event),
        )
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
