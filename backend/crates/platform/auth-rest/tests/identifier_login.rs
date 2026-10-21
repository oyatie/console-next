//! Identifier-first passkey sign-in (decisions #33; sign-in-identifier.md §4–6)
//! on the bare auth router as `console_rt`: the challenge names the account's
//! credentials (a non-resident soft key signs in), every unusable identifier
//! answers in the same shape, a ceremony bound to one account refuses another's
//! credential, an alias signs in only within its grace period, a step-up names
//! only the caller's credentials, and each refusal is typed.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use console_kernel_core::{OrgId, UserId};
use console_platform_auth_rest::{
    AuthRestConfig, AuthRestState, PASSKEY_LOGIN_FINISH_PATH, PASSKEY_LOGIN_START_PATH,
    PASSKEY_STEP_UP_START_PATH, TOKEN_REFRESH_PATH, router,
};
use console_platform_test_support::runtime_role_pool;
use console_platform_test_support::soft_passkey::{SoftKey, passkey_service};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::BTreeSet;
use time::Duration;
use tower::ServiceExt;
use uuid::Uuid;

#[path = "identifier_login/unusable.rs"]
mod unusable;

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

async fn post(
    app: &axum::Router,
    uri: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method("POST").uri(uri);
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

async fn start(app: &axum::Router, identifier: Option<&str>) -> (StatusCode, Value) {
    let body = identifier.map(|id| json!({ "identifier": id }));
    post(app, PASSKEY_LOGIN_START_PATH, None, body).await
}

fn allowed(started: &Value) -> Vec<String> {
    started["challenge"]["publicKey"]["allowCredentials"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap().to_owned())
        .collect()
}

/// The response's shape, values aside: top-level keys, publicKey keys, and
/// each allowCredentials entry's keys and the list length.
fn shape(started: &Value) -> (BTreeSet<String>, BTreeSet<String>, Vec<BTreeSet<String>>) {
    let keys = |v: &Value| {
        v.as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>()
    };
    let public_key = &started["challenge"]["publicKey"];
    let entries = public_key["allowCredentials"]
        .as_array()
        .unwrap()
        .iter()
        .map(keys)
        .collect();
    (keys(started), keys(public_key), entries)
}

/// A fresh active account in the seeded tenant, with its default 아이디.
async fn account(owner: &PgPool, name: &str) -> (UserId, String) {
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO users (display_name, roles, org_id, is_active) VALUES ($1, '{}', $2, true) RETURNING id",
    )
    .bind(name)
    .bind(*OrgId::one().as_uuid())
    .fetch_one(owner)
    .await
    .unwrap();
    let sign_in_id: String = sqlx::query_scalar(
        "SELECT s.login || '@' || o.slug FROM user_sign_in_ids s JOIN organizations o ON o.id = s.org_id \
          WHERE s.user_id = $1 AND s.retired_at IS NULL",
    )
    .bind(id)
    .fetch_one(owner)
    .await
    .expect("every new account gets a default 아이디 at commit");
    (UserId::from_uuid(id), sign_in_id)
}

async fn finish(app: &axum::Router, started: &Value, credential: Value) -> (StatusCode, Value) {
    let body = json!({ "ceremony_id": started["ceremony_id"], "credential": credential });
    post(app, PASSKEY_LOGIN_FINISH_PATH, None, Some(body)).await
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn identifier_first_names_the_accounts_keys_and_a_non_resident_key_signs_in(owner: PgPool) {
    let (user, sign_in_id) = account(&owner, "홍길동").await;
    let mut key = SoftKey::enroll(&owner, OrgId::one(), user).await;
    let app = router(state(runtime_role_pool(&owner).await));

    // Usernameless: an empty list, which a non-resident key cannot answer.
    let (status, usernameless) = start(&app, None).await;
    assert_eq!(status, StatusCode::OK, "{usernameless}");
    assert!(allowed(&usernameless).is_empty());
    assert!(key.assert(&usernameless["challenge"]).is_err());

    // Identifier first (any case): the list names exactly this account's key.
    let (status, started) = start(&app, Some(&sign_in_id.to_uppercase())).await;
    assert_eq!(status, StatusCode::OK, "{started}");
    assert_eq!(allowed(&started), vec![key.credential_id().to_owned()]);
    assert!(
        started["challenge"]
            .get("mediation")
            .is_none_or(Value::is_null)
    );
    let credential = key.assert(&started["challenge"]).unwrap();
    let (status, tokens) = finish(&app, &started, credential).await;
    assert_eq!(status, StatusCode::OK, "{tokens}");
    assert!(tokens["access_token"].is_string());

    // The ceremony was bound to the account.
    let bound: Option<Uuid> =
        sqlx::query_scalar("SELECT user_id FROM auth_webauthn_ceremonies WHERE id = $1::uuid")
            .bind(started["ceremony_id"].as_str().unwrap())
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(bound, Some(*user.as_uuid()));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn every_unusable_identifier_answers_like_a_real_one(owner: PgPool) {
    let (real, real_id) = account(&owner, "실계정").await;
    SoftKey::enroll(&owner, OrgId::one(), real).await;
    let (_, no_passkey_id) = account(&owner, "패스키없음").await;
    let (gone, gone_id) = account(&owner, "비활성").await;
    SoftKey::enroll(&owner, OrgId::one(), gone).await;
    sqlx::query("UPDATE users SET is_active = false WHERE id = $1")
        .bind(*gone.as_uuid())
        .execute(&owner)
        .await
        .unwrap();
    let (aged, _) = account(&owner, "별칭만료").await;
    SoftKey::enroll(&owner, OrgId::one(), aged).await;
    sqlx::query(
        "INSERT INTO user_sign_in_ids (org_id, login, user_id, effective_date, reason_code, retired_at, alias_until) \
         VALUES ($1, 'expired.alias', $2, current_date - 100, 'INPUT_ERROR', now() - interval '100 days', now() - interval '10 days')",
    )
    .bind(*OrgId::one().as_uuid())
    .bind(*aged.as_uuid())
    .execute(&owner)
    .await
    .unwrap();
    let domain = real_id.split_once('@').unwrap().1.to_owned();
    let app = router(state(runtime_role_pool(&owner).await));

    let (status, reference) = start(&app, Some(&real_id)).await;
    assert_eq!(status, StatusCode::OK);
    let unusable = [
        format!("nobody.here@{domain}"),
        "nobody.here@no-such-company".to_owned(),
        no_passkey_id,
        gone_id,
        format!("expired.alias@{domain}"),
    ];
    let unbound = || async {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM auth_webauthn_ceremonies WHERE user_id IS NULL",
        )
        .fetch_one(&owner)
        .await
        .unwrap()
    };
    let before = unbound().await;
    let mut seen = BTreeSet::new();
    for identifier in &unusable {
        let (status, started) = start(&app, Some(identifier)).await;
        assert_eq!(status, StatusCode::OK, "{identifier}: {started}");
        assert_eq!(
            shape(&started),
            shape(&reference),
            "{identifier}: same shape as a real account"
        );
        let ids = allowed(&started);
        assert_eq!(ids.len(), 1, "{identifier}");
        assert_eq!(ids[0].len(), 43, "{identifier}: a 32-byte base64url id");
        // Stable per identifier, distinct across identifiers.
        let (_, again) = start(&app, Some(identifier)).await;
        assert_eq!(
            allowed(&again),
            ids,
            "{identifier}: the same list every time"
        );
        assert!(
            seen.insert(ids[0].clone()),
            "{identifier}: its own synthetic id"
        );
    }
    // Persisted like a real start, but bound to no account.
    assert_eq!(
        unbound().await - before,
        2 * i64::try_from(unusable.len()).unwrap()
    );
}

#[path = "identifier_login/more.rs"]
mod more;
