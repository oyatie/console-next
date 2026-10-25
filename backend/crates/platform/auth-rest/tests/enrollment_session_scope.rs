//! An OTP enrollment session reaches only the enrollment surface, in the auth
//! handlers themselves — this drives the bare auth `router()` without the app's
//! path-level enrollment gate, so the handler check is the only barrier here.
//! PV1 supersedes decision #3: explicit, hash-bound acceptance precedes enrollment; enrollment itself never infers consent.
//! Also on the bare router: open sign-up with no mail sender (R25); and the
//! worker's rate-limit prune as the runtime role (R5).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use console_kernel_core::OrgId;
use console_platform_auth_rest::{
    AUTH_PASSKEYS_PATH, AuthRestConfig, AuthRestState, OTP_REDEEM_PATH,
    PRIVACY_CONSENT_STATUS_PATH, SIGNUP_PATH, prune_rate_limit_windows, router,
};
use console_platform_provisioning::BootstrapCredentialStore;
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use uuid::Uuid;

fn state(pool: PgPool) -> AuthRestState {
    let key = SigningKey::random(&mut OsRng);
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

async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(4)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_rt").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .unwrap()
}

async fn send(
    app: &axum::Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let request = match body {
        Some(body) => builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn registration_finish_without_start_requires_privacy_consent(owner: PgPool) {
    let (app, token, user) = enrollment_session(&owner).await;
    let credential = json!({
        "id": "AA",
        "rawId": "AA",
        "type": "public-key",
        "response": { "attestationObject": "AA", "clientDataJSON": "AA" },
        "clientExtensionResults": {}
    });
    serde_json::from_value::<console_platform_auth::PasskeyRegistrationCredential>(
        credential.clone(),
    )
    .expect("the forged credential must reach the registration handler");
    let (status, body) = send(
        &app,
        "POST",
        "/api/v1/auth/passkey/register/finish",
        Some(&token),
        Some(json!({ "ceremony_id": Uuid::new_v4(), "credential": credential })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "privacy_consent_required");
    let credentials: i64 =
        sqlx::query_scalar("SELECT count(*) FROM auth_webauthn_credentials WHERE user_id=$1")
            .bind(user)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(credentials, 0);
}

async fn enrollment_session(owner: &PgPool) -> (axum::Router, String, Uuid) {
    console_platform_test_support::seed_consent_documents(owner).await;
    let org = OrgId::one();
    let user: Uuid = sqlx::query_scalar(
        "INSERT INTO users (display_name, roles, org_id, is_active) VALUES ('Enrolling', ARRAY['MECHANIC'], $1, true) RETURNING id",
    )
    .bind(*org.as_uuid())
    .fetch_one(owner)
    .await
    .unwrap();
    let rt = runtime_role_pool(owner).await;
    let issue = BootstrapCredentialStore
        .issue_for_zero_credential_user(
            &rt,
            None,
            user,
            org,
            OffsetDateTime::now_utc(),
            Duration::hours(1),
        )
        .await
        .unwrap();
    let app = router(state(rt));

    let (status, redeemed) = send(
        &app,
        "POST",
        OTP_REDEEM_PATH,
        None,
        Some(json!({ "otp": issue.token.as_str() })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{redeemed}");
    assert_eq!(redeemed["privacy_consent_accepted"], false);
    let token = redeemed["access_token"].as_str().unwrap().to_owned();
    (app, token, user)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn enrollment_session_is_refused_outside_the_enrollment_surface(owner: PgPool) {
    let (app, token, user) = enrollment_session(&owner).await;

    // The enrollment surface answers.
    let (status, body) = send(
        &app,
        "POST",
        PRIVACY_CONSENT_STATUS_PATH,
        Some(&token),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // Everything else is 403 passkey_required from the handler itself.
    let (status, body) = send(&app, "GET", AUTH_PASSKEYS_PATH, Some(&token), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "passkey_required");
    let (status, body) = send(
        &app,
        "DELETE",
        &format!("{AUTH_PASSKEYS_PATH}/{}", Uuid::new_v4()),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "passkey_required");
    // First enrollment requires privacy/terms consent before passkey registration can begin.
    let (status, body) = send(
        &app,
        "POST",
        "/api/v1/auth/passkey/register/start",
        Some(&token),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "privacy_consent_required");

    let (status, body) = send(
        &app,
        "POST",
        "/api/v1/auth/passkey/enroll-handoff",
        Some(&token),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let consents: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE actor = $1 AND action = 'privacy.required_accept'",
    )
    .bind(user)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(consents, 0, "no consent is inferred from enrollment");
}

/// With no mail sender (`AuthRestState`'s default, as in production without
/// SMTP) open sign-up refuses before any write: no orphan account.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn signup_without_a_mail_sender_refuses_before_any_write(owner: PgPool) {
    let count = || async {
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM users")
            .fetch_one(&owner)
            .await
            .unwrap()
    };
    let before = count().await;
    let app = router(state(runtime_role_pool(&owner).await));
    let (status, body) = send(
        &app,
        "POST",
        SIGNUP_PATH,
        None,
        Some(json!({ "email": "someone@example.com" })),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(count().await, before, "no account is written");
}

/// The worker prunes rate-limit windows older than an hour as `console_rt`
/// (migration 0296's DELETE grant); a second run finds nothing (replica-safe).
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_runtime_role_prunes_rate_limit_windows_older_than_an_hour(owner: PgPool) {
    sqlx::query(
        "INSERT INTO auth_rate_limit (client_key, endpoint, window_start, attempts) VALUES \
         ('ip:old', 'signup', now() - interval '2 hours', 3), \
         ('ip:new', 'signup', date_trunc('minute', now()), 1)",
    )
    .execute(&owner)
    .await
    .unwrap();
    let rt = runtime_role_pool(&owner).await;
    assert_eq!(prune_rate_limit_windows(&rt).await.unwrap(), 1);
    assert_eq!(prune_rate_limit_windows(&rt).await.unwrap(), 0);
    let left: Vec<String> = sqlx::query_scalar("SELECT client_key FROM auth_rate_limit")
        .fetch_all(&owner)
        .await
        .unwrap();
    assert_eq!(left, ["ip:new"]);
}

#[path = "enrollment_session_scope/consent_snapshot.rs"]
mod consent_snapshot;

#[path = "enrollment_session_scope/unnamed_account.rs"]
mod unnamed_account;
