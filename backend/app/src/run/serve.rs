//! `api` role: the HTTP server and its startup checks.

use crate::config::AppConfig;
use crate::config::role::AppRole;
use crate::error::AppError;
use crate::http::metrics::{install_metrics_recorder, internal_router};
use crate::lifecycle_schedule;
use crate::routes::build_router;
use crate::run::migrate::run_migrations;
use crate::run::shutdown::shutdown_signal;
use crate::run::worker::run_dispatch_worker;
use crate::state::AppState;
use crate::state::DatabaseDependency;
use console_platform_provisioning::BootstrapCredentialStore;
use std::future::IntoFuture;
use std::net::SocketAddr;

pub async fn serve(config: AppConfig, state: AppState) -> Result<(), AppError> {
    if let DatabaseDependency::Postgres(pool) = &state.database {
        assert_no_dev_auth_personas(pool).await?;
    }
    match config.role {
        AppRole::Api => serve_api(config, state).await,
        AppRole::Worker => run_dispatch_worker(config, state).await,
        // Migrate mode never builds an AppState (no HTTP server, no JWT/S3
        // wiring); it is dispatched in `main` before `from_config` runs.
        AppRole::Migrate => run_migrations(&config).await,
        AppRole::SchemaCheck => crate::run::schema_check::run_schema_check(&config).await,
    }
}

/// Refuse to boot (api or worker role) if a dev-auth persona row leaked into
/// this database. `dev-auth:<org>:<role>` is the synthetic `phone` key
/// `DevPrincipalProvisioner` (console-platform-provisioning) upserts for the
/// local role-switch endpoint; that endpoint only exists in a build compiled
/// with `--features dev-auth`, so any such row in a build WITHOUT that
/// feature means a dev database dump (or a devved-up environment's data)
/// reached somewhere it should not have. Compiled out entirely under
/// `dev-auth` (a dev-auth build is expected to have these rows).
///
/// `pub` (rather than private) so `backend/app/tests/*` can exercise both cfg
/// bodies directly without booting a full HTTP server.
#[cfg(not(feature = "dev-auth"))]
pub async fn assert_no_dev_auth_personas(pool: &sqlx::PgPool) -> Result<(), AppError> {
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE phone LIKE 'dev-auth:%'")
        // rls-arming: ok fail-closed boot guard (global users phone prefix census); enforced by console-gate-dev-auth-absence, not a tenant read
        .fetch_one(pool)
        .await
        .map_err(AppError::Database)?;
    if count > 0 {
        return Err(AppError::Internal(format!(
            "refusing to start: {count} dev-auth:* persona row(s) found in `users` — a dev-only \
             database dump reached a build without the dev-auth feature. Purge those phone-prefix \
             persona rows before starting this environment (phone LIKE 'dev-auth:%')."
        )));
    }
    Ok(())
}

#[cfg(feature = "dev-auth")]
pub async fn assert_no_dev_auth_personas(_pool: &sqlx::PgPool) -> Result<(), AppError> {
    Ok(())
}

async fn serve_api(config: AppConfig, state: AppState) -> Result<(), AppError> {
    install_metrics_recorder()?;
    let state_for_router = state.clone();
    seed_cold_start_otp(&config, &state).await?;

    let listener = tokio::net::TcpListener::bind(config.http_addr)
        .await
        .map_err(AppError::Io)?;
    tracing::info!(
        service = %config.service_name,
        role = %config.role,
        addr = %config.http_addr,
        "starting console-app"
    );

    // Scheduled personnel actions also run here: the dev/E2E launcher starts
    // only this role (see `lifecycle_schedule`).
    let lifecycle_schedule_handle = match &state.database {
        DatabaseDependency::Postgres(pool) => Some(lifecycle_schedule::spawn(
            pool.clone(),
            false,
            None,
            state.nts.clone(),
        )),
        DatabaseDependency::NotConfigured => None,
    };
    let internal = spawn_internal_listener(&state).await?;
    // PR-10: once the signal has drained /readyz, in-flight requests get
    // `shutdown_timeout`; past it the process exits rather than outlive the
    // container's stop grace period and be SIGKILLed mid-write.
    let (signalled, on_signal) = tokio::sync::oneshot::channel::<()>();
    let timeout = config.shutdown_timeout;
    let shutdown = async move {
        shutdown_signal(timeout, state).await;
        let _ = signalled.send(());
    };
    let server = axum::serve(
        listener,
        build_router(state_for_router).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown);
    let result = tokio::select! {
        result = server.into_future() => result.map_err(AppError::Io),
        () = async {
            match on_signal.await {
                Ok(()) => tokio::time::sleep(timeout).await,
                Err(_) => std::future::pending().await,
            }
        } => {
            tracing::warn!(timeout_secs = timeout.as_secs(), "in-flight requests outlived the shutdown timeout; exiting");
            Ok(())
        }
    };
    if let Some(handle) = lifecycle_schedule_handle {
        handle.shutdown();
    }
    if let Some(internal) = internal {
        internal.abort();
    }
    result
}

/// P4: `/metrics`, `/healthz` and `/readyz` on `CONSOLE_INTERNAL_ADDR`, when
/// set (api and worker). The public listener then carries no `/metrics`.
pub(crate) async fn spawn_internal_listener(
    state: &AppState,
) -> Result<Option<tokio::task::JoinHandle<()>>, AppError> {
    let Some(addr) = state.config.internal_addr else {
        return Ok(None);
    };
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(AppError::Io)?;
    tracing::info!(%addr, "internal listener (metrics, health) listening");
    let router = internal_router(state);
    Ok(Some(tokio::spawn(async move {
        if let Err(err) = axum::serve(listener, router).await {
            tracing::warn!(error = %err, "internal listener stopped");
        }
    })))
}

/// Seed the cold-start admin's bootstrap OTP at API boot, after migrations have
/// been applied to the database.
///
/// Runs only for the API role with a configured `CONSOLE_COLDSTART_OTP` and a live
/// database. The seeding itself is idempotent and race-safe in the provisioning
/// crate: it inserts a credential only when the cold-start admin has neither a
/// passkey nor an open credential. The OTP value is NEVER logged â only whether a
/// credential was seeded or skipped.
async fn seed_cold_start_otp(config: &AppConfig, state: &AppState) -> Result<(), AppError> {
    let Some(otp) = config.coldstart_otp.as_deref() else {
        tracing::info!(
            "no cold-start OTP configured; skipping cold-start seed (normal once admins exist)"
        );
        return Ok(());
    };
    let DatabaseDependency::Postgres(pool) = &state.database else {
        tracing::info!(
            "cold-start OTP configured but no database is wired; skipping cold-start seed"
        );
        return Ok(());
    };

    let seeded = BootstrapCredentialStore
        .seed_cold_start_credential(
            pool,
            otp,
            config.coldstart_otp_ttl,
            time::OffsetDateTime::now_utc(),
        )
        .await
        .map_err(|err| AppError::Internal(format!("cold-start seed failed: {err}")))?;
    if seeded {
        tracing::info!("cold-start OTP seeded for the cold-start admin");
    } else {
        tracing::info!(
            "cold-start OTP not seeded (admin already has a passkey or an open credential)"
        );
    }
    Ok(())
}

#[cfg(test)]
mod internal_listener_tests {
    use axum::body::Body;
    use http::{Request, StatusCode};
    use tower::ServiceExt;

    use crate::config::AppConfig;
    use crate::http::metrics::{install_metrics_recorder, internal_router};
    use crate::routes::build_router;
    use crate::state::{AppState, DatabaseDependency};

    fn state(internal: Option<&str>) -> AppState {
        let mut pairs = vec![("CONSOLE_HTTP_ADDR", "127.0.0.1:0")];
        pairs.extend(internal.map(|addr| ("CONSOLE_INTERNAL_ADDR", addr)));
        AppState::new(
            AppConfig::from_pairs(pairs).unwrap(),
            DatabaseDependency::NotConfigured,
        )
        .unwrap()
    }

    async fn status(app: axum::Router, uri: &str) -> StatusCode {
        app.oneshot(Request::get(uri).body(Body::empty()).unwrap())
            .await
            .unwrap()
            .status()
    }

    #[tokio::test]
    async fn metrics_leave_the_public_listener_once_an_internal_one_is_set() {
        install_metrics_recorder().unwrap();
        let internal = state(Some("127.0.0.1:0"));
        assert_eq!(
            status(build_router(internal.clone()), "/metrics").await,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            status(build_router(internal.clone()), "/readyz").await,
            StatusCode::OK
        );
        for path in ["/metrics", "/healthz", "/readyz"] {
            assert_eq!(
                status(internal_router(&internal), path).await,
                StatusCode::OK,
                "{path}"
            );
        }
        // Unset: unchanged, /metrics on the one listener.
        assert_eq!(
            status(build_router(state(None)), "/metrics").await,
            StatusCode::OK
        );
    }
}
