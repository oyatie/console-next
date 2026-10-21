//! Graceful shutdown on SIGTERM/ctrl-c.

use crate::config::role::AppRole;
use crate::state::AppState;
use std::sync::atomic::Ordering;
use std::time::Duration;

/// BG-8: how long an api keeps its listener open with `/readyz` at 503, so
/// HAProxy marks it down first (`inter 2s fall 3` in console-infra
/// `host/app/haproxy.cfg`). Then in-flight requests get
/// `CONSOLE_SHUTDOWN_TIMEOUT_SECS`: 6 + 10 s stays under compose's 20 s
/// `stop_grace_period`.
pub(crate) const DRAIN_GRACE: Duration = Duration::from_secs(6);

pub(crate) async fn shutdown_signal(timeout: Duration, state: AppState) {
    let ctrl_c = async {
        if let Err(err) = tokio::signal::ctrl_c().await {
            tracing::warn!(error = %err, "failed to install ctrl-c handler");
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
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

    // The worker's /readyz is no proxy target, and a longer stop would only
    // lengthen the blue/green worker overlap (BG-6).
    let grace = if state.config.role == AppRole::Api {
        DRAIN_GRACE
    } else {
        Duration::ZERO
    };
    drain(&state, grace).await;
    tracing::info!(
        timeout_secs = timeout.as_secs(),
        "shutdown signal received; draining in-flight requests and realtime connections"
    );
    state.shutdown_realtime().await;
}

/// `/readyz` answers 503 from now on; the listener stays open for `grace`.
pub(crate) async fn drain(state: &AppState, grace: Duration) {
    state.draining.store(true, Ordering::Relaxed);
    tracing::info!(
        grace_secs = grace.as_secs(),
        "draining: /readyz answers 503 before the listener closes"
    );
    tokio::time::sleep(grace).await;
}

#[cfg(test)]
mod tests {
    use axum::extract::State;
    use axum::response::IntoResponse;
    use http::StatusCode;
    use std::time::Duration;

    use crate::config::AppConfig;
    use crate::http::ops::readyz;
    use crate::state::{AppState, DatabaseDependency};

    #[tokio::test]
    async fn readyz_answers_503_once_draining() {
        let config = AppConfig::from_pairs([("CONSOLE_HTTP_ADDR", "127.0.0.1:0")]).unwrap();
        let state = AppState::new(config, DatabaseDependency::NotConfigured).unwrap();
        let before = readyz(State(state.clone())).await.into_response();
        assert_eq!(before.status(), StatusCode::OK);
        super::drain(&state, Duration::ZERO).await;
        let after = readyz(State(state)).await.into_response();
        assert_eq!(after.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = axum::body::to_bytes(after.into_body(), 4096).await.unwrap();
        assert!(String::from_utf8_lossy(&body).contains("\"status\":\"draining\""));
    }
}
