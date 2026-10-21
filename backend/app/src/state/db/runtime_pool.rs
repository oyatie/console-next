//! The runtime (`console_rt`) pool, sized against Postgres (decisions #28;
//! `config::db_pool`).

use sqlx::postgres::PgPoolOptions;
use sqlx::{Connection, PgConnection, PgPool};

use crate::config::AppConfig;
use crate::error::AppError;
use crate::state::db::serving::{
    reset_serving_database_connection, validate_database_connection_identity,
    validate_database_pool_identity,
};

/// Postgres's `max_connections`, read over one short-lived connection so the
/// pools can be sized against it before any is opened.
async fn postgres_max_connections(url: &str) -> Result<u32, AppError> {
    let mut conn = PgConnection::connect(url)
        .await
        .map_err(AppError::Database)?;
    let max: String = sqlx::query_scalar("SHOW max_connections")
        .fetch_one(&mut conn)
        .await
        .map_err(AppError::Database)?;
    let _ = conn.close().await;
    max.parse()
        .map_err(|err| AppError::Config(format!("Postgres max_connections {max:?}: {err}")))
}

/// Opens the runtime pool at this role's share of Postgres's connections.
pub(crate) async fn connect_runtime_pool(
    url: &str,
    config: &AppConfig,
) -> Result<PgPool, AppError> {
    let max_connections = postgres_max_connections(url).await?;
    let size = config
        .db_pool
        .runtime_pool_size(config.role, max_connections)?;
    tracing::info!(role = %config.role, size, max_connections, "runtime database pool sized");
    let pool = PgPoolOptions::new()
        .max_connections(size)
        .acquire_timeout(config.db_pool.acquire_timeout)
        // Tenant-isolation backstop. The app connects as the non-owner
        // `console_rt` role under RLS keyed on the `app.current_org` GUC.
        // Every query sets that GUC with SET LOCAL (transaction-scoped,
        // auto-cleared on COMMIT/ROLLBACK), so it cannot normally
        // persist. RESET ALL on release is defense-in-depth: if any
        // future path ever set a *session*-level GUC, this clears it
        // before the pooled connection is reused, so a tenant's
        // `app.current_org` can never bleed into the next request.
        // (RESET ALL keeps prepared statements, unlike DISCARD ALL.)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                validate_database_connection_identity(conn, "DATABASE_URL", "console_rt").await
            })
        })
        .after_release(|conn, _meta| {
            Box::pin(reset_serving_database_connection(
                conn,
                "DATABASE_URL",
                "console_rt",
            ))
        })
        .connect(url)
        .await
        .map_err(AppError::Database)?;
    validate_database_pool_identity(&pool, "DATABASE_URL", "console_rt").await?;
    Ok(pool)
}
