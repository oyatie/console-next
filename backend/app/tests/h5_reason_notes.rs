#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! H5, as `console_rt`: migration 0252 made `employee_lifecycle_events.comment`
//! and `period_locks.reason` optional notes beside `reason_code`, and capped the
//! comment at 1000 characters. A code-only row must still read (200, empty
//! note on the wire), and an over-long comment is a 422, not a 23514 → 500.

#[path = "support/go_live.rs"]
mod go_live;
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

const ISSUER: &str = "console-platform-auth";
const AUDIENCE: &str = "console-api";

async fn send(
    service: &axum::Router,
    method: &str,
    uri: &str,
    token: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header("Idempotency-Key", format!("h5-{}", Uuid::new_v4()));
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

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn code_only_notes_read_and_long_comments_are_refused(pool: PgPool) {
    let org = Uuid::new_v4();
    let slug = format!("h5-{}", &org.simple().to_string()[..12]);
    go_live::live_org(&pool, org, slug, "H5 Co").await;
    let admin = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id, is_active) VALUES ($1, 'H5', $2, $3, true)")
        .bind(*admin.as_uuid())
        .bind(["SUPER_ADMIN"].as_slice())
        .bind(org)
        .execute(&pool)
        .await
        .unwrap();
    console_platform_test_support::seed_passkey(&pool, OrgId::from_uuid(org), admin).await;
    let employee = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO employees (id, org_id, company, name, source_filename, source_sheet, source_row, \
         source_key, raw_row, source_metadata) \
         VALUES ($1, $2, 'H5 Co', '홍길동', 'roster.xlsx', 'Sheet1', 2, $3, '{}', '{}')",
    )
    .bind(employee)
    .bind(org)
    .bind(format!("roster:{employee}"))
    .execute(&pool)
    .await
    .unwrap();
    // Code-only rows, as a reason_code writer (LIFE, LOCK) will store them.
    sqlx::query(
        "INSERT INTO employee_lifecycle_events \
         (org_id, employee_id, event_type, to_status, effective_date, reason_code, created_by) \
         VALUES ($1, $2, 'ONBOARD', 'ACTIVE', '2026-07-01', 'REGULAR_RESHUFFLE', $3)",
    )
    .bind(org)
    .bind(employee)
    .bind(*admin.as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO period_locks (org_id, domain, period_start, period_end, reason_code, locked_by) \
         VALUES ($1, 'payroll', '2026-08-01', '2026-08-31', 'MONTHLY_PAYROLL_CLOSE', $2)",
    )
    .bind(org)
    .bind(*admin.as_uuid())
    .execute(&pool)
    .await
    .unwrap();

    let keys = keys();
    let service = build_router(
        app_state(
            role_pool(&pool, "console_rt").await,
            role_pool(&pool, "console_leave_cmd").await,
            keys.1.clone(),
        )
        .unwrap(),
    );
    let token = token(&pool, &keys, org, admin).await;

    let events = format!("/api/v1/employees/{employee}/lifecycle-events");
    let (status, page) = send(&service, "GET", &events, &token, None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["items"][0]["comment"], "", "{page}");

    let (status, locks) = send(&service, "GET", "/api/v1/period-locks", &token, None).await;
    assert_eq!(status, StatusCode::OK, "{locks}");
    assert!(locks.to_string().contains(r#""reason":"""#), "{locks}");

    let (status, refused) = send(
        &service,
        "POST",
        &events,
        &token,
        Some(json!({
            "event_type": "TRANSFER",
            "effective_date": OffsetDateTime::now_utc().date().to_string(),
            "comment": "가".repeat(1001),
            "signoffs": {"privacy_notice_ack": true, "korean_labor_law_ack": true},
        })),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{refused}");
    assert!(refused.to_string().contains("1000"), "{refused}");
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

async fn token(pool: &PgPool, keys: &(String, String), org: Uuid, user: UserId) -> String {
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
            roles: vec!["SUPER_ADMIN".to_owned()],
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

async fn role_pool(owner: &PgPool, role: &'static str) -> PgPool {
    PgPoolOptions::new()
        .max_connections(6)
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

fn app_state(
    runtime: PgPool,
    leave_command: PgPool,
    public_pem: String,
) -> Result<AppState, console_app::AppError> {
    let config = AppConfig::from_pairs([
        ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ("CONSOLE_JWT_ISSUER", ISSUER.to_owned()),
        ("CONSOLE_JWT_AUDIENCE", AUDIENCE.to_owned()),
        ("CONSOLE_JWT_PUBLIC_KEY_PEM", public_pem),
    ])?;
    AppState::new(config, DatabaseDependency::Postgres(runtime))
        .map(|state| state.with_leave_command_database(leave_command))
}
