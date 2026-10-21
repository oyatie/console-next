//! Durable snapshots shared by the adapter and assembled API security proofs.
use serde_json::Value;
use sqlx::PgPool;

pub async fn business(pool: &PgPool) -> Value {
    sqlx::query_scalar("SELECT jsonb_build_array(        (SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY id), '[]') FROM attendance_batches b),        (SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY id), '[]') FROM attendance_entries e))")
        .fetch_one(pool).await.unwrap()
}
