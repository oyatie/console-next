//! Explicit global document fixture; this never supplies production legal content.
#![allow(clippy::unwrap_used)]
use serde_json::{Value, json};
use sqlx::PgPool;

pub async fn publish(pool: &PgPool) -> Value {
    // rls-arming: ok test-only immutable global document, published by the migration owner.
    sqlx::query("INSERT INTO terms_documents (version, body, published_at) VALUES ('test-v1', 'Integration test service terms fixture', now()) ON CONFLICT (version) DO NOTHING")
        .execute(pool).await.unwrap();
    let sha256: String =
        sqlx::query_scalar("SELECT sha256 FROM terms_documents WHERE version = 'test-v1'")
            .fetch_one(pool)
            .await
            .unwrap();
    json!({ "version": "test-v1", "sha256": sha256 })
}
