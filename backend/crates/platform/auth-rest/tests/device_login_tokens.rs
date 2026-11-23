// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aws_lc_rs::digest::{SHA256, digest};
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use console_kernel_core::{OrgId, UserId};
use console_platform_auth_rest::{
    AuthRestConfig, AuthRestState, DEVICE_LOGIN_APPROVE_PATH, DEVICE_LOGIN_POLL_PATH,
    DEVICE_LOGIN_START_PATH, PASSKEY_LOGIN_START_PATH, router,
};
use console_platform_test_support::runtime_role_pool;
use console_platform_test_support::soft_passkey::SoftKey;
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::Generate;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::Duration;
use tower::ServiceExt;
use uuid::Uuid;

fn test_state(pool: PgPool) -> AuthRestState {
    let key = SigningKey::generate();
    AuthRestState::new(
        pool,
        AuthRestConfig {
            rp_id: "example.com".to_owned(),
            rp_origin: "https://auth.example.com".to_owned(),
            rp_name: "Console".to_owned(),
            ceremony_ttl: Duration::minutes(5),
            jwt_issuer: "console-platform-auth".to_owned(),
            jwt_audience: "console-api".to_owned(),
            access_token_ttl: Duration::minutes(15),
            jwt_private_key_pem: key.to_pkcs8_pem(LineEnding::LF).unwrap().to_string(),
            jwt_public_key_pem: key
                .verifying_key()
                .to_public_key_pem(LineEnding::LF)
                .unwrap(),
            refresh_token_ttl: Duration::days(30),
            refresh_family_absolute_ttl: Duration::hours(24),
            cookie_secure: false,
        },
    )
    .unwrap()
}

async fn post(app: &axum::Router, uri: &str, body: Value) -> (StatusCode, Value) {
    let request = Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn tamper_last_char(token: &str) -> String {
    let mut chars: Vec<char> = token.chars().collect();
    let last = chars.last_mut().unwrap();
    *last = if *last == 'a' { 'b' } else { 'a' };
    chars.into_iter().collect()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn device_login_dual_lookup_accepts_v1_and_v2_and_rejects_tampered(owner: PgPool) {
    let user_id: Uuid = sqlx::query_scalar(
        "INSERT INTO users (display_name, roles, org_id, is_active) VALUES ('DL User', '{}', $1, true) RETURNING id",
    )
    .bind(*OrgId::one().as_uuid())
    .fetch_one(&owner)
    .await
    .unwrap();
    let sign_in_id: String = sqlx::query_scalar(
        "SELECT s.login || '@' || o.slug FROM user_sign_in_ids s JOIN organizations o ON o.id = s.org_id WHERE s.user_id = $1 AND s.retired_at IS NULL",
    )
    .bind(user_id)
    .fetch_one(&owner)
    .await
    .unwrap();
    let mut soft_key = SoftKey::enroll(&owner, OrgId::one(), UserId::from_uuid(user_id)).await;
    let app = router(test_state(runtime_role_pool(&owner).await));

    // 1. Fresh v2 handoff uses 32B CSPRNG base64url + domain-separated hash.
    let (status, started) = post(&app, DEVICE_LOGIN_START_PATH, json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let poll_v2 = started["poll_token"].as_str().unwrap();
    let poll_suffix = poll_v2.strip_prefix("console_dlp_").unwrap();
    assert_eq!(poll_suffix.len(), 43);
    assert_eq!(URL_SAFE_NO_PAD.decode(poll_suffix).unwrap().len(), 32);

    let approve_v2 = started["approve_url"]
        .as_str()
        .unwrap()
        .split("#desktop_approve=")
        .nth(1)
        .unwrap();
    let approve_suffix = approve_v2.strip_prefix("console_dla_").unwrap();
    assert_eq!(approve_suffix.len(), 43);
    assert_eq!(URL_SAFE_NO_PAD.decode(approve_suffix).unwrap().len(), 32);

    let raw_sha_row: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM auth_device_login_handoffs WHERE poll_token_hash = $1")
            .bind(digest(&SHA256, poll_v2.as_bytes()).as_ref().to_vec())
            .fetch_optional(&owner)
            .await
            .unwrap();
    assert!(raw_sha_row.is_none());

    let (status, poll_pending) = post(
        &app,
        DEVICE_LOGIN_POLL_PATH,
        json!({ "poll_token": poll_v2 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(poll_pending["status"], "pending");

    let (status, _) = post(
        &app,
        DEVICE_LOGIN_POLL_PATH,
        json!({ "poll_token": tamper_last_char(poll_v2) }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // 2. Legacy v1 (64-hex + raw SHA-256) handoff approves and polls once via dual-lookup.
    let v1_poll = format!("console_dlp_{}", "1".repeat(64));
    let v1_approve = format!("console_dla_{}", "2".repeat(64));
    sqlx::query(
        "INSERT INTO auth_device_login_handoffs (id, poll_token_hash, approve_token_hash, issued_at, expires_at) VALUES ($1, $2, $3, clock_timestamp(), clock_timestamp() + interval '5 minutes')",
    )
    .bind(Uuid::new_v4())
    .bind(digest(&SHA256, v1_poll.as_bytes()).as_ref().to_vec())
    .bind(digest(&SHA256, v1_approve.as_bytes()).as_ref().to_vec())
    .execute(&owner)
    .await
    .unwrap();

    let (status, login_start) = post(
        &app,
        PASSKEY_LOGIN_START_PATH,
        json!({ "identifier": sign_in_id }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let assertion = soft_key.assert(&login_start["challenge"]).unwrap();

    let (status, _) = post(
        &app,
        DEVICE_LOGIN_APPROVE_PATH,
        json!({
            "approve_token": tamper_last_char(&v1_approve),
            "ceremony_id": login_start["ceremony_id"],
            "credential": assertion,
        }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, _) = post(
        &app,
        DEVICE_LOGIN_APPROVE_PATH,
        json!({
            "approve_token": v1_approve,
            "ceremony_id": login_start["ceremony_id"],
            "credential": assertion,
        }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, consumed) = post(
        &app,
        DEVICE_LOGIN_POLL_PATH,
        json!({ "poll_token": v1_poll }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(consumed["status"], "approved");
    assert!(consumed["access_token"].is_string());

    let (status, _replay) = post(
        &app,
        DEVICE_LOGIN_POLL_PATH,
        json!({ "poll_token": v1_poll }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}
