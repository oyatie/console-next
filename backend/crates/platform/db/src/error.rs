//! Database-layer error type.

use std::cell::Cell;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),

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
        Self::Sqlx(err)
    }
}

/// Runs `f` and says whether a database helper inside it timed out waiting for
/// a pooled connection (decisions #28): the app then answers 503 +
/// `Retry-After` even where a crate mapped the error to an opaque 500.
/// only the `with_*` helpers mark it; a crate's own `pool.begin()`
/// still needs sqlx's text in its error to be shed.
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
    use super::watch_pool_timeouts;
    use crate::with_org_conn;
    use console_kernel_core::OrgId;
    use sqlx::PgPool;
    use sqlx::postgres::PgPoolOptions;

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
