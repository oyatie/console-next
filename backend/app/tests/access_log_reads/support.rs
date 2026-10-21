//! Fixtures for `access_log_reads.rs`: the composed app router as the runtime
//! role with one trusted proxy hop, and requests that carry a socket peer.
#![allow(dead_code)]

use std::net::SocketAddr;

use axum::body::{Body, to_bytes};
use axum::extract::ConnectInfo;
use console_app::{AppConfig, AppRole, AppState, DatabaseDependency};
use console_kernel_core::{BranchId, OrgId, UserId};
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings};
use http::{Method, Request, StatusCode, header};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::Value;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use uuid::Uuid;

pub const ISSUER: &str = "console-platform-auth";
pub const AUDIENCE: &str = "console-api";
/// The configured trusted proxy network and a peer inside it.
pub const PROXY_CIDR: &str = "10.0.0.0/8";
pub const PROXY_PEER: &str = "10.0.0.5:443";
/// A peer outside every trusted network (its forwarding header is ignored).
pub const DIRECT_PEER: &str = "203.0.113.7:40000";

pub struct Call<'a> {
    pub method: Method,
    pub uri: String,
    pub token: &'a str,
    pub peer: &'a str,
    pub forwarded_for: &'a str,
    pub body: Option<(String, Vec<u8>)>,
}

pub async fn send(app: &axum::Router, call: Call<'_>) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(call.method)
        .uri(call.uri)
        .header(header::AUTHORIZATION, format!("Bearer {}", call.token))
        .header("x-forwarded-for", call.forwarded_for);
    let body = match call.body {
        Some((content_type, bytes)) => {
            builder = builder.header(header::CONTENT_TYPE, content_type);
            Body::from(bytes)
        }
        None => Body::empty(),
    };
    let mut request = builder.body(body).unwrap();
    request
        .extensions_mut()
        .insert(ConnectInfo(call.peer.parse::<SocketAddr>().unwrap()));
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()));
    (status, json)
}

pub fn get<'a>(uri: String, token: &'a str, peer: &'a str, forwarded_for: &'a str) -> Call<'a> {
    Call {
        method: Method::GET,
        uri,
        token,
        peer,
        forwarded_for,
        body: None,
    }
}

pub fn import_preview<'a>(token: &'a str, csv: &str) -> Call<'a> {
    let boundary = "piireadsboundary";
    let mut body = Vec::new();
    for (name, value) in [
        ("pay_period_start", "2026-06-01"),
        ("pay_period_end", "2026-06-30"),
    ] {
        body.extend(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .into_bytes(),
        );
    }
    body.extend(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"근태.csv\"\r\n\
             Content-Type: text/csv\r\n\r\n{csv}\r\n--{boundary}--\r\n"
        )
        .into_bytes(),
    );
    Call {
        method: Method::POST,
        uri: "/api/v1/hr/attendance-import/preview".to_owned(),
        token,
        peer: DIRECT_PEER,
        forwarded_for: "198.51.100.99",
        body: Some((format!("multipart/form-data; boundary={boundary}"), body)),
    }
}

pub async fn seed_user(pool: &PgPool, org: Uuid, role: &str) -> UserId {
    let user = UserId::new();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id, is_active) VALUES ($1, 'PII', $2, $3, true)",
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

pub async fn seed_employee(pool: &PgPool, org: Uuid) -> Uuid {
    let id = Uuid::new_v4();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO employees (id, org_id, company, name, employee_number, employment_status, \
         source_filename, source_sheet, source_row, source_key, raw_row, source_metadata) \
         VALUES ($1, $2, 'PII Co', 'Kim', 'E-1', 'ACTIVE', 'roster.xlsx', 'Sheet1', 2, $3, '{}', '{}')",
    )
    .bind(id)
    .bind(org)
    .bind(format!("roster:{id}"))
    .execute(tx.as_mut())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    id
}

/// An HQ-confirmed case with a computed (uncertified) settlement draft.
pub async fn seed_exit_case_with_settlement(
    pool: &PgPool,
    org: Uuid,
    employee: Uuid,
    actor: UserId,
) -> Uuid {
    let case = Uuid::new_v4();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO employee_exit_cases (id, org_id, employee_id, status, effective_exit_date, \
         site_manager_note, reported_by) VALUES ($1, $2, $3, 'SETTLEMENT_READY', '2026-09-30', 'note', $4)",
    )
    .bind(case)
    .bind(org)
    .bind(employee)
    .bind(*actor.as_uuid())
    .execute(tx.as_mut())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO employee_exit_settlement_packages (org_id, exit_case_id, employee_id, status, \
         service_days, average_wage_total_won, average_daily_wage_milliwon, severance_pay_won, \
         monthly_ordinary_wage_won, statutory_basis, insurance_loss_payload, approval_payload) \
         VALUES ($1, $2, $3, 'READY_FOR_APPROVAL', 400, 9000000, 97826087, 9000000, 3000000, \
         '{\"average_wage_total_won\": 9000000}', '{\"wage\": 9000000}', '{\"severance_pay_won\": 9000000}')",
    )
    .bind(org)
    .bind(case)
    .bind(employee)
    .execute(tx.as_mut())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    case
}

pub async fn runtime_pool(pool: &PgPool) -> PgPool {
    let options = pool.connect_options().as_ref().clone();
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

pub fn app_state(pool: PgPool, public_pem: String) -> AppState {
    let config = AppConfig::from_pairs([
        ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ("CONSOLE_JWT_ISSUER", ISSUER.to_owned()),
        ("CONSOLE_JWT_AUDIENCE", AUDIENCE.to_owned()),
        ("CONSOLE_JWT_PUBLIC_KEY_PEM", public_pem),
        ("CONSOLE_TRUSTED_PROXY_COUNT", "1".to_owned()),
        ("CONSOLE_TRUSTED_PROXY_CIDRS", PROXY_CIDR.to_owned()),
    ])
    .unwrap();
    AppState::new(config, DatabaseDependency::Postgres(pool)).unwrap()
}

pub async fn token(
    pool: &PgPool,
    private_pem: &str,
    public_pem: &str,
    user: UserId,
    org: Uuid,
    role: &str,
) -> String {
    let settings = JwtSettings {
        issuer: ISSUER.to_owned(),
        audience: AUDIENCE.to_owned(),
        access_token_ttl: Duration::minutes(15),
    };
    let issuer =
        JwtIssuer::from_es256_pem(settings, private_pem.as_bytes(), public_pem.as_bytes()).unwrap();
    console_platform_test_support::issue_session_token(
        pool,
        &issuer,
        AccessTokenInput {
            subject: user,
            org_id: OrgId::from_uuid(org),
            roles: vec![role.to_owned()],
            branches: Vec::<BranchId>::new(),
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
        Vec::new(),
    )
    .await
}

/// A fresh ES256 key pair as (private, public) PEM.
pub fn signing_pems() -> (String, String) {
    let key = SigningKey::random(&mut OsRng);
    let private_pem = key.to_pkcs8_pem(LineEnding::LF).unwrap().to_string();
    let public_pem = key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    (private_pem, public_pem)
}
