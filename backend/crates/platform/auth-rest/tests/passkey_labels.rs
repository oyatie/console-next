// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use console_kernel_core::{OrgId, UserId};
use console_platform_auth_rest::{AuthRestConfig, AuthRestState, router};
use console_platform_test_support::{runtime_role_pool, soft_passkey::SoftKey};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::Duration;
use tower::ServiceExt;
use uuid::Uuid;

fn auth_state(pool: PgPool) -> AuthRestState {
    let key = SigningKey::random(&mut OsRng);
    AuthRestState::new(
        pool,
        AuthRestConfig {
            rp_id: "example.com".into(),
            rp_origin: "https://auth.example.com".into(),
            rp_name: "Console".into(),
            ceremony_ttl: Duration::minutes(5),
            jwt_issuer: "console-platform-auth".into(),
            jwt_audience: "console-api".into(),
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

async fn request(
    app: &axum::Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let response = app
        .clone()
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn account(pool: &PgPool) -> UserId {
    let id = sqlx::query_scalar("INSERT INTO users(display_name,roles,org_id) VALUES ('패스키 사용자','{}',$1) RETURNING id")
        .bind(*OrgId::one().as_uuid()).fetch_one(pool).await.unwrap();
    UserId::from_uuid(id)
}

struct Fixture {
    owner: PgPool,
    app: axum::Router,
    token: String,
    key: Uuid,
    soft: SoftKey,
}

impl Fixture {
    async fn new(owner: PgPool) -> Self {
        let user = account(&owner).await;
        let mut soft = SoftKey::enroll(&owner, OrgId::one(), user).await;
        let app = router(auth_state(runtime_role_pool(&owner).await));
        let sign_in_id: String = sqlx::query_scalar("SELECT s.login || '@' || o.slug FROM user_sign_in_ids s JOIN organizations o ON o.id=s.org_id WHERE s.user_id=$1 AND s.retired_at IS NULL")
            .bind(user.as_uuid()).fetch_one(&owner).await.unwrap();
        let (status, started) = request(
            &app,
            "POST",
            "/api/v1/auth/passkey/login/start",
            None,
            json!({"identifier": sign_in_id}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{started}");
        let credential = soft.assert(&started["challenge"]).unwrap();
        let (status, tokens) = request(
            &app,
            "POST",
            "/api/v1/auth/passkey/login/finish",
            None,
            json!({"ceremony_id": started["ceremony_id"], "credential": credential}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{tokens}");
        let token = tokens["access_token"].as_str().unwrap();
        let (status, documents) = request(
            &app,
            "POST",
            "/api/v1/auth/privacy-consent/status",
            Some(token),
            json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{documents}");
        let (status, accepted) = request(
            &app,
            "POST",
            "/api/v1/auth/privacy-consent/accept",
            Some(token),
            json!({
                "privacy": documents["privacy"], "terms": documents["terms"],
                "privacy_collection": true, "terms_of_service": true,
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{accepted}");
        let key = sqlx::query_scalar("SELECT id FROM auth_webauthn_credentials WHERE user_id=$1")
            .bind(user.as_uuid())
            .fetch_one(&owner)
            .await
            .unwrap();
        Self {
            owner,
            app,
            token: token.into(),
            key,
            soft,
        }
    }

    async fn rename(&self, key: Uuid, label: Value) -> (StatusCode, Value) {
        request(
            &self.app,
            "PATCH",
            &format!("/api/v1/auth/passkeys/{key}"),
            Some(&self.token),
            json!({"label": label}),
        )
        .await
    }

    async fn state(&self, key: Uuid) -> (Value, i64) {
        let row =
            sqlx::query_scalar("SELECT to_jsonb(c) FROM auth_webauthn_credentials c WHERE id=$1")
                .bind(key)
                .fetch_one(&self.owner)
                .await
                .unwrap();
        let audits = sqlx::query_scalar(
            "SELECT count(*) FROM audit_events WHERE action='auth.passkey.rename'",
        )
        .fetch_one(&self.owner)
        .await
        .unwrap();
        (row, audits)
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn own_passkey_label_roundtrips_and_is_audited(owner: PgPool) {
    let f = Fixture::new(owner).await;
    let (status, renamed) = f.rename(f.key, json!("  업무용 보안키 🔑  ")).await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!(renamed["label"], "업무용 보안키 🔑");
    let (status, listed) = request(
        &f.app,
        "GET",
        "/api/v1/auth/passkeys",
        Some(&f.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!(listed[0]["label"], renamed["label"]);
    let audit: (Value, Value) = sqlx::query_as("SELECT before_snap,after_snap FROM audit_events WHERE action='auth.passkey.rename' AND target_id=$1")
        .bind(f.key.to_string()).fetch_one(&f.owner).await.unwrap();
    assert!(audit.0["label"].is_null());
    assert_eq!(audit.1["label"], "업무용 보안키 🔑");
    let boundary = "가".repeat(80);
    let (status, renamed) = f.rename(f.key, json!(boundary)).await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!(renamed["label"], boundary);
    let (status, reset) = f.rename(f.key, Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{reset}");
    assert!(reset["label"].is_null());
    assert_eq!(f.state(f.key).await.1, 3);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn another_users_passkey_is_not_found_and_unchanged(owner: PgPool) {
    let f = Fixture::new(owner).await;
    let other = account(&f.owner).await;
    SoftKey::enroll(&f.owner, OrgId::one(), other).await;
    let key = sqlx::query_scalar("SELECT id FROM auth_webauthn_credentials WHERE user_id=$1")
        .bind(other.as_uuid())
        .fetch_one(&f.owner)
        .await
        .unwrap();
    let before = f.state(key).await;
    let (status, refused) = f.rename(key, json!("다른 사람의 키")).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{refused}");
    assert_eq!(f.state(key).await, before);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn invalid_passkey_labels_are_typed_and_write_nothing(owner: PgPool) {
    let f = Fixture::new(owner).await;
    let before = f.state(f.key).await;
    for invalid in [
        "".to_owned(),
        "   ".to_owned(),
        "줄\n바꿈".to_owned(),
        "탭\t키".to_owned(),
        "가".repeat(81),
    ] {
        let (status, refused) = f.rename(f.key, json!(invalid)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{refused}");
        assert_eq!(refused["error"]["code"], "passkey_label_invalid");
        assert_eq!(f.state(f.key).await, before);
    }
}

#[path = "passkey_labels/registration.rs"]
mod registration;
