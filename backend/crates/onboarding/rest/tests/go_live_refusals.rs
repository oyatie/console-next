#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use axum::http::StatusCode;
use common::*;
use console_platform_test_support::soft_passkey::SoftKey;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_account_without_live_ops_authority_is_forbidden_before_passkey_checks(owner: PgPool) {
    let h = harness(&owner, false).await;
    for (method, path, body) in [
        ("GET", "/api/v1/onboarding/checklist", Value::Null),
        ("GET", "/api/v1/onboarding/go-live/preview", Value::Null),
        (
            "POST",
            "/api/v1/onboarding/go-live",
            json!({ "digest": "0".repeat(64) }),
        ),
    ] {
        assert_refused(
            &owner,
            &h,
            method,
            path,
            body,
            (StatusCode::FORBIDDEN, "forbidden", None),
        )
        .await;
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn go_live_refusals_bind_the_preview_and_keep_the_phase_unchanged(owner: PgPool) {
    let h = harness(&owner, true).await;
    let mut key = SoftKey::enroll(&owner, h.actor.org, h.actor.user).await;
    let (status, old) = send(&h, "GET", "/api/v1/onboarding/go-live/preview", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        send(&h, "POST", "/api/v1/onboarding/steps/roles/skip", json!({}))
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    let assertion = key.step_up(&owner).await;
    let before = state(&owner, &h).await;
    let (status, stale) = send(
        &h,
        "POST",
        "/api/v1/onboarding/go-live",
        json!({
            "digest": old["digest"], "line_digests": old["line_digests"], "step_up": assertion,
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(stale["error"]["code"], "preview_stale");
    assert!(
        stale["error"]["details"]["changed_codes"]
            .as_array()
            .unwrap()
            .contains(&json!("facts"))
    );
    assert_eq!(state(&owner, &h).await, before);
    let logged: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM audit_events WHERE org_id = $1 AND action = 'tenant.onboarding_refused' AND after_snap->>'code' = 'preview_stale')")
        .bind(h.actor.org.as_uuid()).fetch_one(&owner).await.unwrap();
    assert!(logged);
    let (_, current) = send(&h, "GET", "/api/v1/onboarding/go-live/preview", Value::Null).await;
    assert_eq!(stale["error"]["details"]["digest"], current["digest"]);
    let assertion = key.step_up(&owner).await;
    assert_refused(
        &owner,
        &h,
        "POST",
        "/api/v1/onboarding/go-live",
        json!({
            "digest": current["digest"], "step_up": assertion,
        }),
        (
            StatusCode::CONFLICT,
            "go_live_blocked",
            Some("accept_terms"),
        ),
    )
    .await;
    // The last audit identifies the unmet acceptance as a field, not a generic failure.
    let fields: Value = sqlx::query_scalar("SELECT after_snap->'fields' FROM audit_events WHERE org_id = $1 AND after_snap->>'code' = 'go_live_blocked' ORDER BY occurred_at DESC LIMIT 1")
        .bind(h.actor.org.as_uuid()).fetch_one(&owner).await.unwrap();
    assert!(
        fields
            .as_array()
            .unwrap()
            .contains(&json!("terms_accepted"))
    );
    let mut assertion = key.step_up(&owner).await;
    assertion["ceremony_id"] = json!(Uuid::new_v4());
    assert_refused(
        &owner,
        &h,
        "POST",
        "/api/v1/onboarding/go-live",
        json!({
            "digest": current["digest"], "step_up": assertion,
        }),
        (
            StatusCode::UNAUTHORIZED,
            "passkey_step_up_failed",
            Some("passkey_step_up"),
        ),
    )
    .await;
    // rls-arming: ok owner-only phase fixture for a replay; the request still verifies a real passkey.
    sqlx::query("UPDATE tenant_phase SET phase = 'OPERATING' WHERE org_id = $1")
        .bind(h.actor.org.as_uuid())
        .execute(&owner)
        .await
        .unwrap();
    let assertion = key.step_up(&owner).await;
    assert_refused(
        &owner,
        &h,
        "POST",
        "/api/v1/onboarding/go-live",
        json!({ "digest": current["digest"], "step_up": assertion }),
        (StatusCode::CONFLICT, "phase_not_setup", None),
    )
    .await;
}
