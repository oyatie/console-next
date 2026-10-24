#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! PERF-BE (decisions #28): a request that gets no pooled connection in time is
//! shed — 503 `unavailable` + `Retry-After`, no internal text, nothing written —
//! never a 500. Runs as `console_rt` through the full router (redact layer on).

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
use serde_json::Value;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use uuid::Uuid;

const ISSUER: &str = "console-platform-auth";
const AUDIENCE: &str = "console-api";

/// regression: before PERF-BE the HR adapter turned `PoolTimedOut` into a 500
/// `employee directory request failed` (soak: 243 × 500, every one after the
/// 3 s acquire), which the redact layer could not recognise.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_pool_exhaustion_sheds_503_with_retry_after_and_writes_nothing(pool: PgPool) {
    let org = Uuid::new_v4();
    go_live::live_org(
        &pool,
        org,
        format!("shed-{}", &org.simple().to_string()[..12]),
        "Shed Co",
    )
    .await;
    let admin = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id, is_active) VALUES ($1, 'Shed', $2, $3, true)")
        .bind(*admin.as_uuid())
        .bind(["SUPER_ADMIN"].as_slice())
        .bind(org)
        .execute(&pool)
        .await
        .unwrap();
    console_platform_test_support::seed_passkey(&pool, OrgId::from_uuid(org), admin).await;
    let keys = keys();
    // One runtime connection, a short acquire: holding it starves every request.
    let runtime = role_pool(&pool, "console_rt", 1).await;
    let service = build_router(app_state(
        runtime.clone(),
        role_pool(&pool, "console_leave_cmd", 2).await,
        keys.1.clone(),
    ));
    let token = token(&pool, &keys, org, admin).await;
    let reads = || async {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM audit_events WHERE org_id = $1 AND action = 'employee.list_read'",
        )
        .bind(org)
        .fetch_one(&pool)
        .await
        .unwrap()
    };

    let held = runtime.acquire().await.unwrap();
    let (status, retry, body) = get(&service, &token, "/api/v1/employees?limit=10").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(retry.as_deref(), Some("2"));
    assert_eq!(body["error"]["code"], "unavailable");
    let message = body["error"]["message"].as_str().unwrap();
    assert!(
        !message.contains("pool"),
        "no internal text leaves: {message}"
    );
    assert!(body["error"]["trace_id"].is_string());
    let (status, retry, _) = get(&service, &token, "/api/v1/employees/facets").await;
    assert_eq!(
        (status, retry.as_deref()),
        (StatusCode::SERVICE_UNAVAILABLE, Some("2"))
    );
    // guard: a starved org-structure read is shed too (its session check is
    // the app middleware's here; entity's own opaque-500 path is covered by
    // platform-db's regression_a_helper_pool_timeout_marks_the_watched_request
    // and redact's opaque-500 unit test).
    let (status, retry, body) = get(&service, &token, "/api/v1/org-structure").await;
    assert_eq!(
        (status, retry.as_deref()),
        (StatusCode::SERVICE_UNAVAILABLE, Some("2")),
        "{body}"
    );
    assert_eq!(body["error"]["code"], "unavailable");
    assert_eq!(reads().await, 0, "a shed read writes no access-log row");

    drop(held);
    let (status, retry, body) = get(&service, &token, "/api/v1/employees?limit=10").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(retry, None);
    assert_eq!(reads().await, 1);
}

async fn get(
    service: &axum::Router,
    token: &str,
    uri: &str,
) -> (StatusCode, Option<String>, Value) {
    let request = Request::builder()
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let response = service.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let retry = response
        .headers()
        .get(header::RETRY_AFTER)
        .map(|v| v.to_str().unwrap().to_owned());
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        retry,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
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

async fn role_pool(owner: &PgPool, role: &'static str, size: u32) -> PgPool {
    PgPoolOptions::new()
        .max_connections(size)
        .acquire_timeout(std::time::Duration::from_millis(300))
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

fn app_state(runtime: PgPool, leave_command: PgPool, public_pem: String) -> AppState {
    let config = AppConfig::from_pairs([
        ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ("CONSOLE_JWT_ISSUER", ISSUER.to_owned()),
        ("CONSOLE_JWT_AUDIENCE", AUDIENCE.to_owned()),
        ("CONSOLE_JWT_PUBLIC_KEY_PEM", public_pem),
    ])
    .unwrap();
    AppState::new(config, DatabaseDependency::Postgres(runtime))
        .unwrap()
        .with_leave_command_database(leave_command)
}
