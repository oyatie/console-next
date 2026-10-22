#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use axum::http::StatusCode;
use common::*;
use serde_json::{Value, json};
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn roles_and_terms_refusals_have_status_code_no_write_and_an_audit(owner: PgPool) {
    let h = harness(&owner, true).await;
    assert_eq!(
        send(&h, "GET", "/api/v1/onboarding/terms", Value::Null)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        send(&h, "POST", "/api/v1/onboarding/steps/roles/skip", json!({}))
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_refused(
        &owner,
        &h,
        "POST",
        "/api/v1/onboarding/steps/roles/skip",
        json!({}),
        (StatusCode::CONFLICT, "step_already_skipped", None),
    )
    .await;
    assert_refused(
        &owner,
        &h,
        "POST",
        "/api/v1/onboarding/steps/no/skip",
        json!({}),
        (StatusCode::UNPROCESSABLE_ENTITY, "step_not_skippable", None),
    )
    .await;
    // rls-arming: ok owner publishes immutable test terms, never a production seed.
    let hash: String = sqlx::query_scalar("INSERT INTO terms_documents (version, body, published_at) VALUES ('v1', 'Test fixture', now()) RETURNING sha256").fetch_one(&owner).await.unwrap();
    assert_refused(
        &owner,
        &h,
        "POST",
        "/api/v1/onboarding/terms",
        json!({"version":"v1", "sha256":"invalid"}),
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_failed",
            Some("review_terms"),
        ),
    )
    .await;
    assert_refused(
        &owner,
        &h,
        "POST",
        "/api/v1/onboarding/terms",
        json!({"version":"v1", "sha256":"0".repeat(64)}),
        (
            StatusCode::CONFLICT,
            "terms_text_changed",
            Some("review_terms"),
        ),
    )
    .await;
    assert_eq!(
        send(
            &h,
            "POST",
            "/api/v1/onboarding/terms",
            json!({"version":"v1", "sha256":hash})
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_refused(
        &owner,
        &h,
        "POST",
        "/api/v1/onboarding/terms",
        json!({"version":"v1", "sha256":hash}),
        (
            StatusCode::CONFLICT,
            "terms_version_already_accepted",
            Some("return_to_preview"),
        ),
    )
    .await;
    assert_refused(
        &owner,
        &h,
        "POST",
        "/api/v1/onboarding/go-live",
        json!({"digest":"0".repeat(64)}),
        (
            StatusCode::PRECONDITION_REQUIRED,
            "passkey_step_up_required",
            Some("passkey_step_up"),
        ),
    )
    .await;
    // rls-arming: ok owner-only phase fixture; replay must refuse without changing it.
    sqlx::query("UPDATE tenant_phase SET phase = 'OPERATING' WHERE org_id = $1")
        .bind(h.actor.org.as_uuid())
        .execute(&owner)
        .await
        .unwrap();
    assert_refused(
        &owner,
        &h,
        "POST",
        "/api/v1/onboarding/steps/roles/skip",
        json!({}),
        (StatusCode::CONFLICT, "phase_not_setup", None),
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn legacy_terms_map_to_current_hash_and_invalid_shapes_leave_no_write(owner: PgPool) {
    let h = harness(&owner, true).await;
    assert_refused(
        &owner,
        &h,
        "POST",
        "/api/v1/onboarding/terms",
        json!({"terms_version": "v1"}),
        (
            StatusCode::CONFLICT,
            "terms_text_changed",
            Some("review_terms"),
        ),
    )
    .await;
    // rls-arming: ok owner publishes immutable test terms, never a production seed.
    let hash: String = sqlx::query_scalar("INSERT INTO terms_documents (version, body, published_at) VALUES ('v1', 'Legacy test fixture', now()) RETURNING sha256").fetch_one(&owner).await.unwrap();
    for body in [
        json!({}),
        json!({"version": "v1"}),
        json!({"sha256": hash}),
        json!({"terms_version": "v1", "sha256": hash}),
        json!({"version": "v1", "sha256": hash, "terms_version": "other"}),
        json!({"terms_version": ""}),
        json!({"terms_version": "x".repeat(41)}),
    ] {
        assert_refused(
            &owner,
            &h,
            "POST",
            "/api/v1/onboarding/terms",
            body,
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation_failed",
                Some("review_terms"),
            ),
        )
        .await;
    }
    assert_refused(
        &owner,
        &h,
        "POST",
        "/api/v1/onboarding/terms",
        json!({"terms_version": "old"}),
        (
            StatusCode::CONFLICT,
            "terms_text_changed",
            Some("review_terms"),
        ),
    )
    .await;
    assert_eq!(
        send(
            &h,
            "POST",
            "/api/v1/onboarding/terms",
            json!({"terms_version": "v1"})
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    let stored: String = sqlx::query_scalar(
        "SELECT sha256 FROM tenant_terms_acceptances WHERE org_id = $1 AND version = 'v1'",
    )
    .bind(h.actor.org.as_uuid())
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(stored, hash);
    assert_refused(
        &owner,
        &h,
        "POST",
        "/api/v1/onboarding/terms",
        json!({"version": "v1", "sha256": hash, "terms_version": "v1"}),
        (
            StatusCode::CONFLICT,
            "terms_version_already_accepted",
            Some("return_to_preview"),
        ),
    )
    .await;
    // rls-arming: ok immutable revised terms fixture exercises stale N-1 clients.
    let next: String = sqlx::query_scalar("INSERT INTO terms_documents (version, body, published_at) VALUES ('v2', 'Revised fixture', clock_timestamp()) RETURNING sha256").fetch_one(&owner).await.unwrap();
    assert_refused(
        &owner,
        &h,
        "POST",
        "/api/v1/onboarding/terms",
        json!({"terms_version": "v1"}),
        (
            StatusCode::CONFLICT,
            "terms_text_changed",
            Some("review_terms"),
        ),
    )
    .await;
    assert_eq!(
        send(
            &h,
            "POST",
            "/api/v1/onboarding/terms",
            json!({"version": "v2", "sha256": next})
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(state(&owner, &h).await.1, 2);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn legacy_terms_still_require_the_live_ops_holder(owner: PgPool) {
    let h = harness(&owner, false).await;
    assert_refused(
        &owner,
        &h,
        "POST",
        "/api/v1/onboarding/terms",
        json!({"terms_version": "v1"}),
        (StatusCode::FORBIDDEN, "forbidden", None),
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unpublished_documents_leave_a_refusal_audit(owner: PgPool) {
    let h = harness(&owner, true).await;
    // Disposable fixture DB: model an operator who has published no legal documents.
    sqlx::query("TRUNCATE terms_documents CASCADE")
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
