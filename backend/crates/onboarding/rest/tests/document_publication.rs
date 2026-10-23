// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
mod common;
use axum::http::StatusCode;
use common::*;
use serde_json::Value;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn missing_privacy_notice_refuses_without_substituting_service_terms(owner: PgPool) {
    let h = harness(&owner, true).await;
    let (version, body): (String, String) = sqlx::query_as(
        "SELECT version, body FROM terms_documents WHERE kind = 'service_terms' ORDER BY published_at DESC LIMIT 1",
    ).fetch_one(&owner).await.unwrap();
    sqlx::query("TRUNCATE terms_documents CASCADE")
        .execute(&owner)
        .await
        .unwrap();
    sqlx::query("INSERT INTO terms_documents (version, body, published_at) VALUES ($1, $2, now())")
        .bind(version)
        .bind(body)
        .execute(&owner)
        .await
        .unwrap();
    assert_refused(
        &owner,
        &h,
        "GET",
        "/api/v1/onboarding/terms",
        Value::Null,
        (
            StatusCode::CONFLICT,
            "terms_not_published",
            Some("contact_service_operator"),
        ),
    )
    .await;
}
