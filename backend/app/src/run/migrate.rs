//! `migrate` role: the embedded migrator and its advisory lock.

use crate::config::AppConfig;
use crate::error::AppError;
use crate::schema_install;
use crate::state::db::migration::enforce_migration_database_budgets;
use crate::state::db::migration::migration_database_pool_options;
use crate::state::db::migration::prepare_migration_database_connection;
use console_platform_jobs::migrate_and_reconcile_apalis_postgres;
use sqlx::PgConnection;
use std::time::Duration;

/// Embedded schema migrations, compiled into the binary at build time from the
/// canonical `console-platform-db` migration directory (the same `0001..NNNN_*.sql`
/// files applied to prod). `migrate` mode runs these in version order; sqlx
/// tracks applied versions + per-file checksums in `_sqlx_migrations`, so re-runs
/// are idempotent and a mutated already-applied file is rejected rather than
/// silently re-run. The path is relative to this crate's manifest (`backend/app`).
pub(crate) static MIGRATOR: sqlx::migrate::Migrator =
    sqlx::migrate!("../crates/platform/db/migrations");

pub(crate) const MIGRATION_LOCK_TIMEOUT: &str = "5s";
pub(crate) const MIGRATION_STATEMENT_TIMEOUT: &str = "60s";

/// Apply the embedded schema migrations against `DATABASE_URL`, then return.
///
/// This is the `migrate` run-mode (an Argo CD PreSync Job). It is deliberately
/// lean: it needs ONLY `DATABASE_URL` (the OWNER `console_app` connection that can
/// run DDL) â no JWT keys, S3 creds, or any other app config â so a migration
/// Job can run with a minimal environment. It opens a tiny single-connection
/// pool, runs the migrator (idempotent: sqlx skips versions already recorded in
/// `_sqlx_migrations`), logs how many were applied, then returns so the process
/// can exit 0. Any DDL/connection error propagates so the Job fails (non-zero)
/// and Argo blocks the sync.
pub async fn run_migrations(config: &AppConfig) -> Result<(), AppError> {
    let database_url = config
        .database_url
        .as_deref()
        .ok_or_else(|| AppError::Config("migrate role requires DATABASE_URL".to_owned()))?;

    let pool = migration_database_pool_options()
        .connect(database_url)
        .await
        .map_err(AppError::Database)?;

    // `after_connect` has already enforced the migration budgets and exact
    // migration identity on this physical connection. Keep the same checkout
    // through the preflight count, migration run, and final count so no
    // unvalidated connection can enter the migration execution path.
    // Detach: on every error/cancellation path the physical connection closes,
    // releasing its session lock instead of returning a locked checkout.
    let mut connection = pool.acquire().await.map_err(AppError::Database)?.detach();
    sqlx::query("SET SESSION search_path = public")
        .execute(&mut connection)
        .await
        .map_err(AppError::Database)?;
    acquire_migration_lock(&mut connection).await?;
    let applied_before = applied_migration_count(&mut connection).await?;
    let embedded = MIGRATOR.iter().count();

    tracing::info!(
        embedded,
        applied_before,
        "applying schema migrations (migrate mode)"
    );

    // Close the time-of-check gap as far as the database protocol permits:
    // revalidate the same physical connection immediately before handing it
    // to SQLx's migrator.
    prepare_migration_database_connection(&mut connection)
        .await
        .map_err(AppError::Database)?;

    schema_install::run(&mut connection).await?;

    // Apalis' vendor migrations are deliberately owned by the same one-shot
    // migration boundary rather than by an API/worker login. Reuse the exact
    // already-validated physical checkout so the runtime `console_rt` role never
    // needs schema or migration-ledger write privileges.
    migrate_and_reconcile_apalis_postgres(&mut connection)
        .await
        .map_err(|err| AppError::Internal(format!("apalis migration run failed: {err}")))?;

    // Reassert the owner identity and migration budgets after both migration
    // engines have completed, before reading the final ledger and releasing
    // the physical connection.
    prepare_migration_database_connection(&mut connection)
        .await
        .map_err(AppError::Database)?;

    let applied_after = applied_migration_count(&mut connection).await?;
    let newly_applied = applied_after.saturating_sub(applied_before);

    if newly_applied == 0 {
        tracing::info!(
            applied = applied_after,
            "schema is up to date; nothing to apply"
        );
    } else {
        tracing::info!(
            newly_applied,
            applied = applied_after,
            "schema migrations applied"
        );
    }

    sqlx::Connection::close(connection)
        .await
        .map_err(AppError::Database)?;
    pool.close().await;
    Ok(())
}

async fn acquire_migration_lock(connection: &mut PgConnection) -> Result<(), AppError> {
    // A blocking advisory-lock query remains an open virtual transaction.
    // CREATE INDEX CONCURRENTLY in the current migration owner waits for it,
    // producing a deadlock with another migrator waiting for that same lock.
    // Bound each wait so PostgreSQL can finish its index scan between attempts.
    sqlx::query("SET SESSION lock_timeout = '100ms'")
        .execute(&mut *connection)
        .await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        match sqlx::migrate::Migrate::lock(&mut *connection).await {
            Ok(()) => break,
            Err(sqlx::migrate::MigrateError::Execute(sqlx::Error::Database(error)))
                if error.code().as_deref() == Some("55P03")
                    && tokio::time::Instant::now() < deadline =>
            {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            Err(error) => {
                return Err(AppError::Internal(format!(
                    "migration lock failed: {error}"
                )));
            }
        }
    }
    enforce_migration_database_budgets(connection).await?;
    Ok(())
}

/// Count rows in sqlx's `_sqlx_migrations` ledger, returning 0 before the table
/// exists (a fresh database, before the first `MIGRATOR.run`). Used only to log
/// how many migrations a `migrate` run newly applied.
async fn applied_migration_count(connection: &mut PgConnection) -> Result<usize, AppError> {
    let exists: bool =
        sqlx::query_scalar("SELECT to_regclass('public._sqlx_migrations') IS NOT NULL")
            .fetch_one(&mut *connection)
            .await
            .map_err(AppError::Database)?;
    if !exists {
        return Ok(0);
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations WHERE success")
        .fetch_one(connection)
        .await
        .map_err(AppError::Database)?;
    usize::try_from(count)
        .map_err(|err| AppError::Internal(format!("invalid migration count: {err}")))
}
