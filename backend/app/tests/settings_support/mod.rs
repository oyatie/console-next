// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(dead_code)]
use axum::body::{Body, to_bytes};
use console_app::{AppConfig, AppRole, AppState, DatabaseDependency};
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings};
use http::{Request, StatusCode, header};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use uuid::Uuid;

const ISSUER: &str = "console-platform-auth";
const AUDIENCE: &str = "console-api";

pub async fn send(
    service: &axum::Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("Idempotency-Key", Uuid::new_v4().to_string());
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
    let response = service.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(json!({})))
}

pub async fn seed_user(pool: &PgPool, org: Uuid, role: &str) -> UserId {
    let user = UserId::new();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id, is_active) VALUES ($1, 'S', $2, $3, true)",
    )
    .bind(*user.as_uuid())
    .bind([role].as_slice())
    .bind(org)
    .execute(pool)
    .await
    .unwrap();
    console_platform_test_support::seed_passkey(pool, OrgId::from_uuid(org), user).await;
    user
}

pub fn keys() -> (String, String) {
    let key = SigningKey::random(&mut OsRng);
    (
        key.to_pkcs8_pem(LineEnding::LF).unwrap().to_string(),
        key.verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap(),
    )
}

pub async fn token(
    pool: &PgPool,
    keys: &(String, String),
    org: Uuid,
    user: UserId,
    role: &str,
) -> String {
    let issuer = JwtIssuer::from_es256_pem(
        JwtSettings {
            issuer: ISSUER.to_owned(),
            audience: AUDIENCE.to_owned(),
            access_token_ttl: Duration::minutes(15),
        },
        keys.0.as_bytes(),
        keys.1.as_bytes(),
    )
    .unwrap();
    console_platform_test_support::issue_session_token(
        pool,
        &issuer,
        AccessTokenInput {
            subject: user,
            org_id: OrgId::from_uuid(org),
            roles: vec![role.to_owned()],
            branches: Vec::new(),
            platform: false,
            support: None,
            read_only: false,
            display_name: None,
            feature_grants: Vec::new(),
            authz_subject_version: 0,
            authz_policy_version: 0,
            session_generation: 0,
            issued_at: OffsetDateTime::now_utc(),
        },
        None,
        vec![],
    )
    .await
}

pub async fn runtime_pool(owner: &PgPool) -> PgPool {
    PgPoolOptions::new()
        .max_connections(6)
        .after_connect(|conn, _| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_rt").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(owner.connect_options().as_ref().clone())
        .await
        .unwrap()
}

pub fn app_state(runtime: PgPool, public_pem: String) -> Result<AppState, console_app::AppError> {
    let config = AppConfig::from_pairs([
        ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ("CONSOLE_JWT_ISSUER", ISSUER.to_owned()),
        ("CONSOLE_JWT_AUDIENCE", AUDIENCE.to_owned()),
        ("CONSOLE_JWT_PUBLIC_KEY_PEM", public_pem),
    ])?;
    AppState::new(config, DatabaseDependency::Postgres(runtime))
}

pub async fn seed_legal_entity(pool: &PgPool, org: Uuid, user: UserId) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO legal_entities (org_id, id, biz_kind, created_change_mode, created_by)
         VALUES ($1, $2, 'INDIVIDUAL', 'SETUP', $3)",
    )
    .bind(org)
    .bind(id)
    .bind(*user.as_uuid())
    .execute(pool)
    .await
    .unwrap();
    id
}

pub async fn seed_role_and_grant(
    pool: &PgPool,
    org: Uuid,
    granter: UserId,
    grantee: UserId,
    scope_kind: &str,
    legal_entity_id: Option<Uuid>,
) -> Uuid {
    let role_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO access_roles (org_id, id, name_ko, status, version, created_by)
         VALUES ($1, $2, $3, 'ACTIVE', 1, $4)",
    )
    .bind(org)
    .bind(role_id)
    .bind(format!(
        "settings manager {}",
        &role_id.simple().to_string()[..8]
    ))
    .bind(*granter.as_uuid())
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO access_role_versions (org_id, role_id, version, name_ko, status, change_mode, created_by)
         VALUES ($1, $2, 1, $3, 'ACTIVE', 'SETUP', $4)",
    )
    .bind(org)
    .bind(role_id)
    .bind(format!("settings manager {}", &role_id.simple().to_string()[..8]))
    .bind(*granter.as_uuid())
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO access_role_lines (org_id, role_id, version, domain, levels)
         VALUES ($1, $2, 1, 'settings', ARRAY['edit'])",
    )
    .bind(org)
    .bind(role_id)
    .execute(pool)
    .await
    .unwrap();

    let grant_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO access_grants (
            org_id, id, account_id, role_id, scope_kind, legal_entity_id,
            valid_from, effective_in_setup, change_mode, reason_code, granted_by
         ) VALUES ($1, $2, $3, $4, $5, $6, now() - interval '1 minute', true, 'SETUP', 'TEST', $7)",
    )
    .bind(org)
    .bind(grant_id)
    .bind(*grantee.as_uuid())
    .bind(role_id)
    .bind(scope_kind)
    .bind(legal_entity_id)
    .bind(*granter.as_uuid())
    .execute(pool)
    .await
    .unwrap();

    grant_id
}
