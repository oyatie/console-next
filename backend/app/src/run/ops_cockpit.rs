// SPDX-License-Identifier: LicenseRef-Proprietary
use std::future::IntoFuture;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use console_ops_adapter_http::{
    HttpAlertmanager, HttpReadLimits, HttpVictoriaMetrics, HttpVmalert,
};
use console_ops_application::home::{CockpitEvaluator, SourcePorts};
use console_ops_domain::bundle::SourceEndpointSettings;
use console_ops_rest::access_jwt::AccessJwtVerifier;
use console_ops_rest::operators::OperatorRegistry;
use console_ops_rest::state::OpsRestState;
use console_ops_rest::{init_ops_metrics, spawn_evaluator_loop};
use tokio::sync::{Mutex, watch};

use crate::config::AppConfig;
use crate::error::AppError;
use crate::http::metrics::install_metrics_recorder;
use crate::run::ops_cockpit_http::{OpsProbeState, build_ops_router, ops_internal_router};
use crate::run::shutdown::DRAIN_GRACE;
use crate::telemetry::current_trace_context;

fn to_http_limits(ep: &SourceEndpointSettings) -> Result<HttpReadLimits, AppError> {
    let val = serde_json::to_value(&ep.read_limits)
        .map_err(|e| AppError::OpsConfig(format!("OPS_CONFIG_INVALID: read_limits: {e}")))?;
    serde_json::from_value(val)
        .map_err(|e| AppError::OpsConfig(format!("OPS_CONFIG_INVALID: read_limits: {e}")))
}

pub async fn run(config: AppConfig) -> Result<(), AppError> {
    let ops_cfg = config.ops_cockpit.clone().ok_or_else(|| {
        AppError::OpsConfig("OPS_CONFIG_INVALID: missing ops cockpit config".to_owned())
    })?;
    install_metrics_recorder()?;
    init_ops_metrics();

    let registry = Arc::new(
        OperatorRegistry::from_json(&ops_cfg.operators_json)
            .map_err(|e| AppError::OpsConfig(format!("OPS_CONFIG_INVALID: operators.json: {e}")))?,
    );
    let jwt = Arc::new(
        AccessJwtVerifier::new(&ops_cfg.settings.access)
            .map_err(|e| AppError::OpsConfig(format!("OPS_CONFIG_INVALID: access: {e}")))?,
    );

    let am = &ops_cfg.settings.sources.alertmanager;
    let vm = &ops_cfg.settings.sources.vmalert;
    let vmetrics = &ops_cfg.settings.sources.victoriametrics;
    let ports = SourcePorts {
        alertmanager: Arc::new(
            HttpAlertmanager::new(&am.url, am.interval_s, to_http_limits(am)?).map_err(|e| {
                AppError::OpsConfig(format!("OPS_CONFIG_INVALID: alertmanager: {e}"))
            })?,
        ),
        vmalert: Arc::new(
            HttpVmalert::new(&vm.url, vm.interval_s, to_http_limits(vm)?)
                .map_err(|e| AppError::OpsConfig(format!("OPS_CONFIG_INVALID: vmalert: {e}")))?,
        ),
        victoriametrics: Arc::new(
            HttpVictoriaMetrics::new(
                &vmetrics.url,
                vmetrics.interval_s,
                to_http_limits(vmetrics)?,
            )
            .map_err(|e| {
                AppError::OpsConfig(format!("OPS_CONFIG_INVALID: victoriametrics: {e}"))
            })?,
        ),
    };

    let now = time::OffsetDateTime::now_utc();
    let _ = jwt.refresh(now).await;
    metrics::gauge!("ops_cockpit_access_jwks_age_seconds").set(jwt.jwks_age_seconds(now) as f64);

    let evaluator = Arc::new(Mutex::new(CockpitEvaluator::new(
        ports,
        ops_cfg.components.clone(),
        ops_cfg.settings.clone(),
        now,
    )));
    let initial = evaluator.lock().await.evaluate(now);
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let ops_state = OpsRestState::new(
        registry,
        jwt,
        initial,
        ops_cfg.settings.origin.clone(),
        shutdown_rx.clone(),
    )
    .with_support_ref(Arc::new(|| current_trace_context().trace_id().to_owned()));

    ops_state.apply_evaluation(&evaluator).await;
    let eval_interval_s = ops_cfg
        .settings
        .budgets
        .get("evaluate_interval_s")
        .map(|n| n.get())
        .unwrap_or(15);
    let eval_handle = spawn_evaluator_loop(
        ops_state.clone(),
        Arc::clone(&evaluator),
        Duration::from_secs(eval_interval_s),
        shutdown_rx,
    );

    let ready = Arc::new(AtomicBool::new(true));
    let draining = Arc::new(AtomicBool::new(false));
    let internal_handle = match config.internal_addr {
        Some(addr) => {
            let listener = tokio::net::TcpListener::bind(addr)
                .await
                .map_err(AppError::Io)?;
            tracing::info!(%addr, "ops internal listener (metrics, health) listening");
            let router = ops_internal_router(OpsProbeState {
                service_name: config.service_name.clone(),
                ready: Arc::clone(&ready),
                draining: Arc::clone(&draining),
            });
            Some(tokio::spawn(async move {
                if let Err(err) = axum::serve(listener, router).await {
                    tracing::warn!(error = %err, "ops internal listener stopped");
                }
            }))
        }
        None => None,
    };

    let listener = tokio::net::TcpListener::bind(config.http_addr)
        .await
        .map_err(AppError::Io)?;
    tracing::info!(
        service = %config.service_name,
        role = %config.role,
        addr = %config.http_addr,
        "starting console-app ops cockpit"
    );

    let router = build_ops_router(&config, ops_state, ready, Arc::clone(&draining));
    let (signalled, on_signal) = tokio::sync::oneshot::channel::<()>();
    let shutdown_timeout = config.shutdown_timeout;
    let shutdown_fut = async move {
        wait_for_signal().await;
        draining.store(true, Ordering::Relaxed);
        tracing::info!(grace_secs = DRAIN_GRACE.as_secs(), "ops draining /readyz");
        tokio::time::sleep(DRAIN_GRACE).await;
        let _ = shutdown_tx.send(true);
        let _ = signalled.send(());
    };

    let server = axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_fut);

    let result = tokio::select! {
        res = server.into_future() => res.map_err(AppError::Io),
        () = async {
            match on_signal.await {
                Ok(()) => tokio::time::sleep(shutdown_timeout).await,
                Err(_) => std::future::pending().await,
            }
        } => {
            tracing::warn!(timeout_secs = shutdown_timeout.as_secs(), "ops shutdown timeout reached");
            Ok(())
        }
    };
    eval_handle.abort();
    if let Some(handle) = internal_handle {
        handle.abort();
    }
    result
}

async fn wait_for_signal() {
    let ctrl_c = async {
        if let Err(err) = tokio::signal::ctrl_c().await {
            tracing::warn!(error = %err, "failed to install ctrl-c handler");
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(err) => {
                tracing::warn!(error = %err, "failed to install SIGTERM handler");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}
