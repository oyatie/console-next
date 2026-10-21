#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! SEC-02 through the real router: a signing-key rotation (stage → switch →
//! retire) never cuts a session, and a retired key's token is refused with the
//! uniform 401 (the client refreshes and gets a token under the current key).

use axum::body::{Body, to_bytes};
use console_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::{JwtIssuer, JwtSettings};
use console_platform_provisioning::BootstrapCredentialStore;
use console_platform_test_support::MIGRATOR;
use http::{Request, StatusCode, header};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;

const ISSUER: &str = "console-platform-auth";
const AUDIENCE: &str = "console-api";

struct Key {
    private_pem: String,
    public_pem: String,
}

impl Key {
    fn new() -> Self {
        let signing = SigningKey::random(&mut OsRng);
        Self {
            private_pem: signing.to_pkcs8_pem(LineEnding::LF).unwrap().to_string(),
            public_pem: signing
                .verifying_key()
                .to_public_key_pem(LineEnding::LF)
                .unwrap(),
        }
    }

    /// The one-line form `CONSOLE_JWT_ROTATION_PUBLIC_KEYS` carries (PEM body).
    fn spki(&self) -> String {
        self.public_pem
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect()
    }

    fn kid(&self) -> String {
        JwtIssuer::from_es256_pem(
            JwtSettings {
                issuer: ISSUER.to_owned(),
                audience: AUDIENCE.to_owned(),
                access_token_ttl: Duration::minutes(15),
            },
            self.private_pem.as_bytes(),
            self.public_pem.as_bytes(),
        )
        .unwrap()
        .kid()
        .to_owned()
    }
}

/// One app colour: signs with `signing`, also trusts `rotation`.
fn colour(pool: &PgPool, signing: &Key, rotation: &[&Key]) -> axum::Router {
    let rotation: Vec<String> = rotation.iter().map(|k| k.spki()).collect();
    let config = AppConfig::from_pairs([
        ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ("CONSOLE_JWT_ISSUER", ISSUER.to_owned()),
        ("CONSOLE_JWT_AUDIENCE", AUDIENCE.to_owned()),
        ("CONSOLE_JWT_PRIVATE_KEY_PEM", signing.private_pem.clone()),
        ("CONSOLE_JWT_PUBLIC_KEY_PEM", signing.public_pem.clone()),
        ("CONSOLE_JWT_ROTATION_PUBLIC_KEYS", rotation.join(" ")),
        ("CONSOLE_WEBAUTHN_RP_ID", "example.com".to_owned()),
        (
            "CONSOLE_WEBAUTHN_RP_ORIGIN",
            "https://auth.example.com".to_owned(),
        ),
        ("CONSOLE_WEBAUTHN_RP_NAME", "Console".to_owned()),
    ])
    .unwrap();
    build_router(AppState::new(config, DatabaseDependency::Postgres(pool.clone())).unwrap())
}

async fn call(
    app: &axum::Router,
    method: &str,
    uri: &str,
    bearer: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = bearer {
        request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let body = if method == "GET" {
        Body::empty()
    } else {
        Body::from(body.to_string())
    };
    let response = app
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// An OTP first sign-in: an enrollment session (access + body refresh token).
async fn sign_in(app: &axum::Router, pool: &PgPool) -> (String, String) {
    let user = UserId::new();
    sqlx::query(
        "INSERT INTO users (id, display_name, phone, roles, org_id) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(*user.as_uuid())
    .bind("Rotation User")
    .bind("010-1234-0031")
    .bind(vec!["MECHANIC"])
    .bind(*OrgId::one().as_uuid())
    .execute(pool)
    .await
    .unwrap();
    let otp = BootstrapCredentialStore
        .issue_for_zero_credential_user(
            pool,
            None,
            *user.as_uuid(),
            OrgId::one(),
            OffsetDateTime::now_utc(),
            Duration::hours(1),
        )
        .await
        .unwrap();
    let (status, body) = call(
        app,
        "POST",
        "/api/v1/auth/otp/redeem",
        None,
        json!({ "otp": otp.token.as_str() }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    (
        body["access_token"].as_str().unwrap().to_owned(),
        body["refresh_token"].as_str().unwrap().to_owned(),
    )
}

fn kid_of(token: &str) -> Option<String> {
    jsonwebtoken::decode_header(token).unwrap().kid
}

/// The auth surface verifies the bearer (200) for an enrollment session.
async fn auth_surface(app: &axum::Router, access: &str) -> StatusCode {
    let uri = "/api/v1/auth/privacy-consent/status";
    call(app, "POST", uri, Some(access), json!({})).await.0
}

/// A business route: a verified enrollment session gets 403 `passkey_required`;
/// a token from an untrusted key never gets that far.
async fn business(app: &axum::Router, access: &str) -> (StatusCode, Value) {
    call(app, "GET", "/api/v1/employees", Some(access), Value::Null).await
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn rotation_keeps_sessions_and_refuses_the_retired_key(pool: PgPool) {
    let (k1, k2) = (Key::new(), Key::new());
    let before = colour(&pool, &k1, &[]);
    let staged = colour(&pool, &k1, &[&k1, &k2]);
    let switched = colour(&pool, &k2, &[&k1, &k2]);
    let retired = colour(&pool, &k2, &[]);

    let (old_access, refresh) = sign_in(&before, &pool).await;
    assert_eq!(kid_of(&old_access), Some(k1.kid()));

    // Switch: the token signed before it still verifies on every colour.
    for app in [&staged, &switched] {
        assert_eq!(auth_surface(app, &old_access).await, StatusCode::OK);
        assert_eq!(business(app, &old_access).await.0, StatusCode::FORBIDDEN);
    }

    // The refresh token is opaque: refreshing on the switched colour keeps the
    // session and mints under the new key, which the staged colour accepts.
    let (status, rotated) = call(
        &switched,
        "POST",
        "/api/v1/auth/token/refresh",
        None,
        json!({ "refresh_token": refresh }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{rotated}");
    let new_access = rotated["access_token"].as_str().unwrap().to_owned();
    assert_eq!(kid_of(&new_access), Some(k2.kid()));
    assert_eq!(auth_surface(&staged, &new_access).await, StatusCode::OK);

    // Retire: the old key's token is refused; the new one still works.
    let (status, body) = business(&retired, &old_access).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["code"], "unauthorized", "{body}");
    assert_eq!(
        auth_surface(&retired, &old_access).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        business(&retired, &new_access).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(auth_surface(&retired, &new_access).await, StatusCode::OK);
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn a_rotation_key_that_is_not_base64_spki_stops_the_app_at_boot(pool: PgPool) {
    let k1 = Key::new();
    let err = AppConfig::from_pairs([
        ("CONSOLE_JWT_PRIVATE_KEY_PEM", k1.private_pem.clone()),
        ("CONSOLE_JWT_PUBLIC_KEY_PEM", k1.public_pem.clone()),
        ("CONSOLE_JWT_ROTATION_PUBLIC_KEYS", k1.public_pem.clone()),
        ("CONSOLE_WEBAUTHN_RP_ID", "example.com".to_owned()),
        (
            "CONSOLE_WEBAUTHN_RP_ORIGIN",
            "https://auth.example.com".to_owned(),
        ),
    ])
    .unwrap_err();
    assert!(
        err.to_string().contains("CONSOLE_JWT_ROTATION_PUBLIC_KEYS"),
        "{err}"
    );
    // Well-formed base64 that is not a P-256 key fails when the verifier is built.
    let config = AppConfig::from_pairs([
        ("CONSOLE_JWT_PRIVATE_KEY_PEM", k1.private_pem.clone()),
        ("CONSOLE_JWT_PUBLIC_KEY_PEM", k1.public_pem.clone()),
        ("CONSOLE_JWT_ROTATION_PUBLIC_KEYS", "AAAA".to_owned()),
        ("CONSOLE_WEBAUTHN_RP_ID", "example.com".to_owned()),
        (
            "CONSOLE_WEBAUTHN_RP_ORIGIN",
            "https://auth.example.com".to_owned(),
        ),
    ])
    .unwrap();
    let err = AppState::new(config, DatabaseDependency::Postgres(pool))
        .err()
        .unwrap();
    assert!(
        err.to_string().contains("CONSOLE_JWT_ROTATION_PUBLIC_KEYS"),
        "{err}"
    );
}
