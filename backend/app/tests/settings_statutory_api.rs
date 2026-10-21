#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! INT-6a: the settings registry, the reason-code catalog and the statutory
//! register through the composed app router, signed in as `console_rt`.
//! Reads answer any signed-in member; every write goes through Cedar and stays
//! closed (403, nothing written) until its per-action schema is enrolled.

use axum::body::{Body, to_bytes};
use console_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings};
use console_settings_domain::SettingKey;
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

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn settings_and_statutory_answer_signed_in_users_and_writes_stay_closed(pool: PgPool) {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'Settings Co')")
        .bind(org)
        .bind(format!("set-{}", &org.simple().to_string()[..12]))
        .execute(&pool)
        .await
        .unwrap();
    let keys = keys();
    let member = seed_user(&pool, org, "MEMBER").await;
    let admin = seed_user(&pool, org, "SUPER_ADMIN").await;
    let member_token = token(&pool, &keys, org, member, "MEMBER").await;
    let admin_token = token(&pool, &keys, org, admin, "SUPER_ADMIN").await;
    let service = build_router(app_state(runtime_pool(&pool).await, keys.1.clone()).unwrap());

    let settings = "/api/v1/settings";
    let codes = "/api/v1/statutory/insurance-loss-codes?insurer=EI&on=2026-10-01";
    let catalog = "/api/v1/reason-codes?domain=org_change_reject";
    for uri in [settings, codes, catalog] {
        let (status, body) = send(&service, "GET", uri, None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri}: {body}");
    }

    // Every registered key resolves for a plain member, defaults included.
    let (status, page) = send(&service, "GET", settings, Some(&member_token), None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    let items = page["items"].as_array().unwrap();
    assert_eq!(items.len(), SettingKey::ALL.len(), "{page}");
    assert!(
        page.to_string().contains("auth.idle_timeout_minutes"),
        "{page}"
    );

    // The statutory register: public law, sourced rows, any signed-in user.
    let (status, page) = send(&service, "GET", codes, Some(&member_token), None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    let rows = page["items"].as_array().unwrap();
    assert!(!rows.is_empty(), "{page}");
    assert!(
        rows.iter()
            .all(|r| r["source_url"].as_str().is_some_and(|u| !u.is_empty()))
    );
    let (status, refused) = send(
        &service,
        "GET",
        "/api/v1/statutory/insurance-loss-codes?insurer=EI",
        Some(&member_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{refused}");

    // The reason catalog lists the system codes for any member.
    let (status, page) = send(&service, "GET", catalog, Some(&member_token), None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page.to_string().contains("POLICY_VIOLATION"), "{page}");

    // Writes and history: Cedar-only and not enrolled yet, so closed even
    // for the strongest legacy role, and nothing is written.
    let change = json!({"value": 20, "reason_code": "POLICY_REVIEW"});
    let history = "/api/v1/settings/auth.idle_timeout_minutes/history";
    let add =
        json!({"domain": "org_change_reject", "label_ko": "테스트 사유", "requires_note": false});
    for token in [&member_token, &admin_token] {
        let calls = [
            (
                "POST",
                "/api/v1/settings/auth.idle_timeout_minutes",
                Some(change.clone()),
            ),
            ("GET", history, None),
            ("POST", "/api/v1/reason-codes", Some(add.clone())),
            ("GET", "/api/v1/reason-codes/stats", None),
        ];
        for (method, uri, body) in calls {
            let (status, body) = send(&service, method, uri, Some(token), body).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}: {body}");
        }
    }
    for sql in [
        "SELECT count(*) FROM tenant_setting_overrides WHERE org_id = $1",
        "SELECT count(*) FROM reason_codes WHERE org_id = $1",
    ] {
        let written: i64 = sqlx::query_scalar(sql)
            .bind(org)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(written, 0, "{sql}");
    }
}

async fn send(
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

async fn seed_user(pool: &PgPool, org: Uuid, role: &str) -> UserId {
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

async fn runtime_pool(owner: &PgPool) -> PgPool {
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

fn app_state(runtime: PgPool, public_pem: String) -> Result<AppState, console_app::AppError> {
    let config = AppConfig::from_pairs([
        ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ("CONSOLE_JWT_ISSUER", ISSUER.to_owned()),
        ("CONSOLE_JWT_AUDIENCE", AUDIENCE.to_owned()),
        ("CONSOLE_JWT_PUBLIC_KEY_PEM", public_pem),
    ])?;
    AppState::new(config, DatabaseDependency::Postgres(runtime))
}
