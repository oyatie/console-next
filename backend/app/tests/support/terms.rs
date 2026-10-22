// SPDX-License-Identifier: LicenseRef-Proprietary
//! The current published terms for ordinary setup journeys; version-bump tests publish explicitly.
#![allow(clippy::unwrap_used)]
use serde_json::{Value, json};
use sqlx::PgPool;

pub async fn publish(pool: &PgPool) -> Value {
    let (version, sha256): (String, String) = sqlx::query_as(
        "SELECT version, sha256 FROM terms_documents WHERE kind='service_terms' AND published_at<=now() ORDER BY published_at DESC, version DESC LIMIT 1",
    ).fetch_one(pool).await.unwrap();
    json!({ "version": version, "sha256": sha256 })
}
