//! The real router as `console_rt`, one tenant in SETUP and its SUPER_ADMIN,
//! for the chaos and refusal suites (TEST-BE). Mirrors the first-run journey's
//! harness; `Ctx::call` is one user intent (a fresh Idempotency-Key) and
//! `Ctx::retry` resends the previous one.
#![allow(dead_code)]

use axum::body::{Body, to_bytes};
use console_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
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

#[path = "terms.rs"]
mod terms;

const ISSUER: &str = "console-platform-auth";
const AUDIENCE: &str = "console-api";
/// The 사업자등록번호 `structure()` registers. A reissue states the same number with a new
/// certificate, so the reissue suites send this one (a different number is an identifier correction).
pub const STRUCTURE_BRN: &str = "000-81-00009";

pub struct Ctx {
    pub service: axum::Router,
    pub token: String,
    pub org: Uuid,
    pub user: UserId,
    pub key: std::cell::Cell<Uuid>,
}

impl Ctx {
    /// One user intent: a fresh Idempotency-Key.
    pub async fn call(&self, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
        self.key.set(Uuid::new_v4());
        self.send(method, uri, body, Some(self.key.get())).await
    }

    /// The previous call's retry: the same Idempotency-Key.
    pub async fn retry(&self, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
        self.send(method, uri, body, Some(self.key.get())).await
    }

    pub async fn send(
        &self,
        method: &str,
        uri: &str,
        body: Option<Value>,
        key: Option<Uuid>,
    ) -> (StatusCode, Value) {
        let bytes = body.map(|b| b.to_string().into_bytes());
        self.raw(method, uri, "application/json", bytes, key).await
    }

    pub async fn raw(
        &self,
        method: &str,
        uri: &str,
        content_type: &str,
        body: Option<Vec<u8>>,
        key: Option<Uuid>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
            .header(header::CONTENT_TYPE, content_type);
        if let Some(key) = key {
            builder = builder.header("Idempotency-Key", key.to_string());
        }
        let request = builder
            .body(body.map_or_else(Body::empty, Body::from))
            .unwrap();
        let response = self.service.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({})),
        )
    }
}

/// A tenant in SETUP with one active user holding `roles`.
pub async fn tenant(pool: &PgPool, roles: &[&str]) -> (Uuid, UserId) {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, '혼돈 시험')")
        .bind(org)
        .bind(format!("tb-{}", &org.simple().to_string()[..12]))
        .execute(pool)
        .await
        .unwrap();
    let user = add_user(pool, org, roles).await;
    if roles == ["SUPER_ADMIN"] {
        sqlx::query("UPDATE users SET is_tenant_ops = true WHERE id = $1")
            .bind(user.as_uuid())
            .execute(pool)
            .await
            .unwrap();
    }
    (org, user)
}

pub async fn add_user(pool: &PgPool, org: Uuid, roles: &[&str]) -> UserId {
    let user = UserId::new();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id, is_active) VALUES ($1, '시험자', $2, $3, true)",
    )
    .bind(*user.as_uuid())
    .bind(roles)
    .bind(org)
    .execute(pool)
    .await
    .unwrap();
    user
}

/// The router as `console_rt` / `console_leave_cmd`; `session` runs on every
/// pooled connection after the role switch (e.g. a tighter `lock_timeout`).
pub async fn ctx(
    pool: &PgPool,
    org: Uuid,
    user: UserId,
    roles: &[&str],
    session: Option<&'static str>,
) -> Ctx {
    terms::publish(pool).await;
    let keys = keys();
    Ctx {
        service: build_router(app_state(
            role_pool(pool, "console_rt", session).await,
            role_pool(pool, "console_leave_cmd", session).await,
            &keys,
        )),
        token: token(pool, &keys, org, user, roles).await,
        org,
        user,
        key: std::cell::Cell::new(Uuid::nil()),
    }
}

/// Today in KST: the server dates "today or later" in Asia/Seoul, so a UTC
/// date is yesterday between 00:00 and 09:00 KST.
pub fn today_kst() -> String {
    OffsetDateTime::now_utc()
        .to_offset(time::UtcOffset::from_hms(9, 0, 0).unwrap())
        .date()
        .to_string()
}

pub fn address() -> Value {
    json!({ "source": "MANUAL_UNVERIFIED", "road_addr_part1": "서울특별시 강남구 테헤란로 152",
            "si_nm": "서울특별시", "sgg_nm": "강남구", "detail": "12층" })
}

pub fn entity_body() -> Value {
    json!({
        "biz_kind": "CORPORATION", "name": "주식회사 가나", "representation_mode": "SINGLE",
        "representatives": ["홍길동"], "crn": "000211-0006241", "head_office_address": address(),
    })
}

/// 이용약관 → 법인 → 사업자등록 → 본사 사업장, through the API. Returns
/// (legal entity, workplace, the workplace's default branch, its org unit).
pub async fn structure(ctx: &Ctx) -> (String, String, String, String) {
    let (status, terms) = ctx.call("GET", "/api/v1/onboarding/terms", None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = ctx
        .call(
            "POST",
            "/api/v1/onboarding/terms",
            Some(json!({ "version": terms["version"], "sha256": terms["sha256"] })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, entity) = ctx
        .call("POST", "/api/v1/legal-entities", Some(entity_body()))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{entity}");
    let entity_id = entity["record"]["id"].as_str().unwrap().to_owned();
    let (status, reg) = ctx
        .call("POST", &format!("/api/v1/legal-entities/{entity_id}/registrations"), Some(json!({
            "brn": STRUCTURE_BRN, "trade_name": "주식회사 가나", "opened_on": "2020-03-02",
            "business_address": address(), "unit_taxation": false, "tax_office_label": "삼성세무서",
            "tax_type": "01", "business_types": [{ "is_main": true, "sector": "정보통신업", "item": "응용 소프트웨어 개발" }],
        })))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{reg}");
    let (status, wp) = ctx
        .call("POST", &format!("/api/v1/legal-entities/{entity_id}/workplaces"), Some(json!({
            "name": "본사", "registration_id": reg["record"]["id"], "same_address_as_registration": true,
            "opened_on": "2020-03-02", "is_head_office": true, "kind_code": "HEAD_OFFICE",
            "insurance": { "shortcut": "ALL_ESTABLISHED_NUMBERS_LATER" },
        })))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{wp}");
    let text = |v: &Value| v.as_str().unwrap().to_owned();
    (
        entity_id,
        text(&wp["record"]["id"]),
        text(&wp["record"]["default_branch_id"]),
        text(&wp["record"]["org_unit_id"]),
    )
}

pub fn employee_body(number: &str, branch: &str, unit: &str) -> Value {
    json!({
        "employee_number": number, "name": format!("직원{number}"), "company": "주식회사 가나",
        "employment_type": "REGULAR", "phone": "010-1234-0000", "position": "사원", "site": "본사",
        "home_branch_id": branch, "base_pay": "3000000", "idempotency_key": format!("tb-{number}"),
        "hire_date": "2026-01-02", "org_unit_id": unit,
    })
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
            view_as: false,
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

pub async fn role_pool(
    owner: &PgPool,
    role: &'static str,
    session: Option<&'static str>,
) -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .after_connect(move |conn, _| {
            Box::pin(async move {
                let statement = if role == "console_rt" {
                    "SET ROLE console_rt"
                } else {
                    "SET ROLE console_leave_cmd"
                };
                sqlx::query(statement).execute(&mut *conn).await?;
                if let Some(session) = session {
                    sqlx::raw_sql(session).execute(&mut *conn).await?;
                }
                Ok(())
            })
        })
        .connect_with(owner.connect_options().as_ref().clone())
        .await
        .unwrap()
}

pub fn app_state(runtime: PgPool, leave_command: PgPool, keys: &(String, String)) -> AppState {
    let config = AppConfig::from_pairs([
        ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ("CONSOLE_JWT_ISSUER", ISSUER.to_owned()),
        ("CONSOLE_JWT_AUDIENCE", AUDIENCE.to_owned()),
        ("CONSOLE_JWT_PUBLIC_KEY_PEM", keys.1.clone()),
        ("CONSOLE_JWT_PRIVATE_KEY_PEM", keys.0.clone()),
        ("CONSOLE_WEBAUTHN_RP_ID", "example.com".to_owned()),
        (
            "CONSOLE_WEBAUTHN_RP_ORIGIN",
            "https://auth.example.com".to_owned(),
        ),
    ])
    .unwrap();
    AppState::new(config, DatabaseDependency::Postgres(runtime))
        .map(|state| state.with_leave_command_database(leave_command))
        .unwrap()
}

/// Rows of `table` in `org`, read as the test owner (BYPASSRLS).
pub async fn count(pool: &PgPool, table: &str, org: Uuid) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT count(*) FROM {table} WHERE org_id = $1"
    )))
    .bind(org)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// Audit rows of `action` in `org`.
pub async fn audits(pool: &PgPool, org: Uuid, action: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id = $1 AND action = $2")
        .bind(org)
        .bind(action)
        .fetch_one(pool)
        .await
        .unwrap()
}
