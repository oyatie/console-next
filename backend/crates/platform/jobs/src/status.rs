//! Public-safe evidence from the worker's existing, read-only heartbeat registry.

/// The queue identity shared by the production worker and its observer.
pub const DISPATCH_QUEUE: &str = "console.dispatch";

pub async fn worker_age_seconds(pool: &sqlx::PgPool) -> Result<Option<i64>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT CEIL(EXTRACT(EPOCH FROM NOW() - MAX(last_seen)))::BIGINT \
         FROM apalis.workers WHERE worker_type = $1",
    )
    .bind(DISPATCH_QUEUE)
    // rls-arming: ok global scheduler registry, aggregate only; no job payload or tenant data
    .fetch_one(pool)
    .await
}
