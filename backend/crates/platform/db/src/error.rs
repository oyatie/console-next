//! Database-layer error type.

use std::cell::Cell;

use console_kernel_core::ErrorKind;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("database unavailable: {0}")]
    Unavailable(#[source] sqlx::Error),

    #[error("database error: {0}")]
    Sqlx(sqlx::Error),

    #[error("serialization error: {0}")]
    Serialize(#[from] serde_json::Error),

    #[error("code issuance error: {0}")]
    CodeIssuance(String),
}

tokio::task_local! {
    static POOL_TIMED_OUT: Cell<bool>;
}

impl DbError {
    /// A helper's failed `begin`: a pool timeout also marks the request
    /// running inside [`watch_pool_timeouts`], if any.
    #[must_use]
    pub fn begin(err: sqlx::Error) -> Self {
        if matches!(err, sqlx::Error::PoolTimedOut) {
            let _ = POOL_TIMED_OUT.try_with(|seen| seen.set(true));
        }
        Self::from(err)
    }

    #[must_use]
    pub const fn kind(&self) -> ErrorKind {
        match self {
            Self::Unavailable(_) => ErrorKind::Unavailable,
            Self::Sqlx(sqlx::Error::RowNotFound) => ErrorKind::NotFound,
            _ => ErrorKind::Internal,
        }
    }

    #[must_use]
    pub const fn is_unavailable(&self) -> bool {
        matches!(self, Self::Unavailable(_))
    }
}

impl From<sqlx::Error> for DbError {
    fn from(error: sqlx::Error) -> Self {
        if matches!(error, sqlx::Error::PoolTimedOut) {
            let _ = POOL_TIMED_OUT.try_with(|seen| seen.set(true));
        }
        if matches!(error, sqlx::Error::PoolTimedOut | sqlx::Error::Io(_)) {
            Self::Unavailable(error)
        } else {
            Self::Sqlx(error)
        }
    }
}

/// Runs `f` and says whether a database helper inside it timed out waiting for
/// a pooled connection (decisions #28): the app then answers 503 +
/// `Retry-After` even where a crate mapped the error to an opaque 500.
/// The shared `DbError` conversion marks the timeout without inspecting driver text.
pub async fn watch_pool_timeouts<F: std::future::Future>(f: F) -> (F::Output, bool) {
    POOL_TIMED_OUT
        .scope(Cell::new(false), async move {
            let out = f.await;
            (out, POOL_TIMED_OUT.with(Cell::get))
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::{DbError, watch_pool_timeouts};
    use crate::with_org_conn;
    use console_kernel_core::{ErrorKind, OrgId};
    use sqlx::PgPool;
    use sqlx::postgres::PgPoolOptions;

    #[test]
    fn pool_and_connection_failures_are_typed_unavailable() {
        assert!(matches!(
            DbError::from(sqlx::Error::PoolTimedOut),
            DbError::Unavailable(_)
        ));
        assert!(matches!(
            DbError::from(sqlx::Error::Io(std::io::Error::new(
                std::io::ErrorKind::ConnectionReset,
                "reset"
            ))),
            DbError::Unavailable(_)
        ));
    }

    #[test]
    fn database_kind_distinguishes_unavailability_from_other_failures() {
        for error in [
            sqlx::Error::PoolTimedOut,
            sqlx::Error::Io(std::io::Error::from(std::io::ErrorKind::ConnectionReset)),
        ] {
            assert_eq!(DbError::from(error).kind(), ErrorKind::Unavailable);
        }
        assert_eq!(
            DbError::from(sqlx::Error::RowNotFound).kind(),
            ErrorKind::NotFound
        );
        for error in [
            DbError::from(sqlx::Error::Protocol("bad frame".into())),
            DbError::from(serde_json::from_str::<bool>("invalid").unwrap_err()),
            DbError::CodeIssuance("no rule".into()),
        ] {
            assert_eq!(error.kind(), ErrorKind::Internal);
        }
    }

    /// regression (PERF-BE): a helper that timed out on the pool marks the
    /// request, so the app sheds it 503 even when the crate's error is opaque.
    #[sqlx::test]
    async fn regression_a_helper_pool_timeout_marks_the_watched_request(pool: PgPool) {
        let starved = PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(std::time::Duration::from_millis(200))
            .connect_with(pool.connect_options().as_ref().clone())
            .await
            .unwrap();
        let org = OrgId::new();
        let read = || {
            with_org_conn::<_, _, super::DbError>(&starved, org, |tx| {
                Box::pin(async move {
                    sqlx::query("SELECT 1").execute(tx.as_mut()).await?;
                    Ok(())
                })
            })
        };
        let (ok, timed_out) = watch_pool_timeouts(read()).await;
        assert!(ok.is_ok() && !timed_out, "a served read is not marked");
        let held = starved.acquire().await.unwrap();
        let (err, timed_out) = watch_pool_timeouts(read()).await;
        assert!(err.is_err() && timed_out, "the starved read is marked");
        // Outside a watch (a spawned job) the mark is a no-op.
        assert!(read().await.is_err());
        drop(held);
    }
}
