//! BG-3: the `schema-check` role. The rollback rehearsal
//! (console-infra `host/compat-check.sh`) runs the previous release with it
//! on the migrated copy: /readyz checks connectivity only, so a dropped column
//! a handler reads shows up here instead of in production. Every
//! compile-time-checked query (`backend/.sqlx`, embedded by `build.rs`) is
//! PREPAREd, never executed. Runtime `sqlx::query` strings are not covered.

use sqlx::{Connection, Executor, PgConnection, SqlStr};

use crate::config::AppConfig;
use crate::error::AppError;

include!(concat!(env!("OUT_DIR"), "/checked_queries.rs"));

/// `Ok` when every checked query prepares (exit 0); otherwise each failure is
/// logged by its `.sqlx` hash and the run fails (exit 1).
pub async fn run_schema_check(config: &AppConfig) -> Result<(), AppError> {
    let url = config
        .database_url
        .as_deref()
        .ok_or_else(|| AppError::Config("schema-check role requires DATABASE_URL".to_owned()))?;
    let mut connection = PgConnection::connect(url)
        .await
        .map_err(AppError::Database)?;
    let failed = prepare_all(&mut connection, CHECKED_QUERIES).await;
    connection.close().await.map_err(AppError::Database)?;
    if failed > 0 {
        return Err(AppError::Internal(format!(
            "schema-check: {failed} of {} checked queries do not prepare on this schema",
            CHECKED_QUERIES.len()
        )));
    }
    tracing::info!(
        queries = CHECKED_QUERIES.len(),
        "schema-check: every checked query prepares"
    );
    Ok(())
}

async fn prepare_all(
    connection: &mut PgConnection,
    queries: &[(&'static str, &'static str)],
) -> usize {
    let mut failed = 0;
    for (hash, sql) in queries {
        if let Err(error) = (&mut *connection).prepare(SqlStr::from_static(sql)).await {
            tracing::error!(query = hash, error = %error, "schema-check: query does not prepare");
            failed += 1;
        }
    }
    failed
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_checked_set_is_embedded() {
        assert!(super::CHECKED_QUERIES.len() >= 40);
        assert!(
            super::CHECKED_QUERIES
                .iter()
                .all(|(hash, sql)| hash.len() == 64 && !sql.is_empty())
        );
    }

    #[cfg(feature = "test-postgres")]
    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn the_current_schema_prepares_every_checked_query(pool: sqlx::PgPool) {
        let mut connection = pool.acquire().await.unwrap();
        assert_eq!(
            super::prepare_all(&mut connection, super::CHECKED_QUERIES).await,
            0
        );
    }

    #[cfg(feature = "test-postgres")]
    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn a_dropped_column_fails_the_check(pool: sqlx::PgPool) {
        let mut connection = pool.acquire().await.unwrap();
        sqlx::query("ALTER TABLE users RENAME COLUMN phone TO phone_gone")
            .execute(&mut *connection)
            .await
            .unwrap();
        let reads_phone = [("t", "SELECT phone FROM users")];
        assert_eq!(super::prepare_all(&mut connection, &reads_phone).await, 1);
        assert_eq!(
            super::prepare_all(&mut connection, &[("t", "SELECT 1")]).await,
            0
        );
    }
}
