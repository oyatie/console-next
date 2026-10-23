//! PERF-BE HTTP fixtures (`perf_bulk_job`): a live tenant, an HR caller with
//! every grant and one with none, the full router as `console_rt`.
#![allow(dead_code)]

use axum::body::{Body, to_bytes};
use console_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings};
use http::{HeaderMap, Request, StatusCode, header};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::Value;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::{Duration, OffsetDateTime, UtcOffset};
use tower::ServiceExt;
use uuid::Uuid;

const ISSUER: &str = "console-platform-auth";
const AUDIENCE: &str = "console-api";

pub struct Ctx {
    pub service: axum::Router,
    /// SUPER_ADMIN (every directory grant).
    pub token: String,
    /// A signed-in account that holds nothing.
    pub roleless: String,
}

impl Ctx {
    pub async fn send(
        &self,
        method: &str,
        uri: &str,
        token: &str,
        key: Option<&str>,
        prefer_async: bool,
        body: Option<Value>,
    ) -> (StatusCode, HeaderMap, Value) {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::AUTHORIZATION, format!("Bearer {token}"));
        if let Some(key) = key {
            builder = builder.header("Idempotency-Key", key);
        }
        if prefer_async {
            builder = builder.header("Prefer", "respond-async");
        }
        let request = match body {
            Some(body) => builder
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
            None => builder.body(Body::empty()).unwrap(),
        };
        let response = self.service.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (
            status,
            headers,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
}

/// Today in Asia/Seoul, as the lifecycle rules read it.
pub fn kst_today() -> String {
    OffsetDateTime::now_utc()
        .to_offset(UtcOffset::from_hms(9, 0, 0).unwrap())
        .date()
        .to_string()
}

pub async fn setup(pool: &PgPool) -> (Ctx, Uuid, UserId) {
    setup_with_runtime(pool, role_pool(pool, "console_rt").await).await
}

/// [`setup`] over a given `console_rt` runtime pool (a starved one, say).
pub async fn setup_with_runtime(pool: &PgPool, runtime: PgPool) -> (Ctx, Uuid, UserId) {
    let org = Uuid::new_v4();
    let slug = format!("perf-{}", &org.simple().to_string()[..12]);
    crate::go_live::live_org(pool, org, slug, "Perf Co").await;
    let admin = seed_user(pool, org, &["SUPER_ADMIN"]).await;
    let nobody = seed_user(pool, org, &[]).await;
    let keys = keys();
    let state = AppState::new(
        AppConfig::from_pairs([
            ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
            ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
            ("CONSOLE_JWT_ISSUER", ISSUER.to_owned()),
            ("CONSOLE_JWT_AUDIENCE", AUDIENCE.to_owned()),
            ("CONSOLE_JWT_PUBLIC_KEY_PEM", keys.1.clone()),
        ])
        .unwrap(),
        DatabaseDependency::Postgres(runtime),
    )
    .unwrap()
    .with_leave_command_database(role_pool(pool, "console_leave_cmd").await);
    let token = token(pool, &keys, org, admin, &["SUPER_ADMIN"]).await;
    let roleless = token_for(pool, &keys, org, nobody, &[]).await;
    (
        Ctx {
            service: build_router(state),
            token,
            roleless,
        },
        org,
        admin,
    )
}

async fn seed_user(pool: &PgPool, org: Uuid, roles: &[&str]) -> UserId {
    let user = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id, is_active) VALUES ($1, 'Perf', $2, $3, true)")
        .bind(*user.as_uuid())
        .bind(roles)
        .bind(org)
        .execute(pool)
        .await
        .unwrap();
    console_platform_test_support::seed_passkey(pool, OrgId::from_uuid(org), user).await;
    user
}

pub async fn seed_employee(pool: &PgPool, org: Uuid, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO employees (id, org_id, company, name, source_filename, source_sheet, source_row, \
         source_key, raw_row, source_metadata) \
         VALUES ($1, $2, 'Perf Co', $3, 'roster.xlsx', 'Sheet1', 2, $4, '{}', '{}')",
    )
    .bind(id)
    .bind(org)
    .bind(name)
    .bind(format!("roster:{id}"))
    .execute(pool)
    .await
    .unwrap();
    id
}

/// An ACTIVE team as fixture rows (the org-change flow is covered elsewhere).
pub async fn seed_org_unit(pool: &PgPool, org: Uuid, actor: UserId, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO org_units (org_id, id) VALUES ($1, $2)")
        .bind(org)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO org_unit_revisions \
         (org_id, org_unit_id, version, command_id, actor_id, payload_digest, attributes, receipt) \
         VALUES ($1, $2, 1, gen_random_uuid(), $3, decode(repeat('00', 32), 'hex'), \
                 jsonb_build_object('name', $4::text, 'kind', 'site'), '{}'::jsonb)",
    )
    .bind(org)
    .bind(id)
    .bind(*actor.as_uuid())
    .bind(name)
    .execute(pool)
    .await
    .unwrap();
    id
}

fn keys() -> (String, String) {
    let key = SigningKey::random(&mut OsRng);
    (
        key.to_pkcs8_pem(LineEnding::LF).unwrap().to_string(),
        key.verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap(),
    )
}

async fn token(
    pool: &PgPool,
    keys: &(String, String),
    org: Uuid,
    user: UserId,
    roles: &[&str],
) -> String {
    token_for(pool, keys, org, user, roles).await
}

async fn token_for(
    pool: &PgPool,
    keys: &(String, String),
    org: Uuid,
    user: UserId,
    roles: &[&str],
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
            roles: roles.iter().map(|r| (*r).to_owned()).collect(),
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

pub async fn role_pool(owner: &PgPool, role: &'static str) -> PgPool {
    sized_role_pool(owner, role, 6, std::time::Duration::from_secs(30)).await
}

pub async fn sized_role_pool(
    owner: &PgPool,
    role: &'static str,
    size: u32,
    acquire: std::time::Duration,
) -> PgPool {
    PgPoolOptions::new()
        .max_connections(size)
        .acquire_timeout(acquire)
        .after_connect(move |conn, _| {
            Box::pin(async move {
                let statement = match role {
                    "console_rt" => "SET ROLE console_rt",
                    _ => "SET ROLE console_leave_cmd",
                };
                sqlx::query(statement).execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(owner.connect_options().as_ref().clone())
        .await
        .unwrap()
}
