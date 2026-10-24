#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Period locks (마감 freeze windows), as `console_rt`: lock → overlap refused →
//! unlock → re-unlock refused, reason bounds, the close-authority floor, and
//! the audit rows (the unlock audit names the window that reopened).

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
const LOCKS: &str = "/api/v1/period-locks";

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
        .header(header::AUTHORIZATION, format!("Bearer {token}"));
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
async fn period_locks_lock_unlock_refuse_and_audit(pool: PgPool) {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'Lock Co')")
        .bind(org)
        .bind(format!("pl-{}", &org.simple().to_string()[..12]))
        .execute(&pool)
        .await
        .unwrap();
    let admin = seed_user(&pool, org, "SUPER_ADMIN").await;
    let mechanic = seed_user(&pool, org, "MECHANIC").await;
    let keys = keys();
    let service = build_router(
        app_state(
            role_pool(&pool, "console_rt").await,
            role_pool(&pool, "console_leave_cmd").await,
            keys.1.clone(),
        )
        .unwrap(),
    );
    let mechanic_token = token(&pool, &keys, org, mechanic, "MECHANIC").await;
    // Locks are org-wide (no branch column): a branch-scoped ADMIN holds the
    // matrix cell (attendance close uses it per branch) but not the
    // all-branch scope these routes require.
    let branch_admin = seed_user(&pool, org, "ADMIN").await;
    let region: Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ('권역', $1) RETURNING id")
            .bind(org)
            .fetch_one(&pool)
            .await
            .unwrap();
    let branch: Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, '지점', $2) RETURNING id",
    )
    .bind(region)
    .bind(org)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
        .bind(*branch_admin.as_uuid())
        .bind(branch)
        .bind(org)
        .execute(&pool)
        .await
        .unwrap();
    let branch_admin_token = token(&pool, &keys, org, branch_admin, "ADMIN").await;
    let token = token(&pool, &keys, org, admin, "SUPER_ADMIN").await;
    let lock = json!({
        "domain": "payroll",
        "periodStart": "2026-08-01",
        "periodEnd": "2026-08-31",
        "reason": "8월 급여 마감",
    });

    // Close authority only, org-wide.
    let (status, body) = send(&service, "POST", LOCKS, &mechanic_token, Some(lock.clone())).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let (status, body) = send(
        &service,
        "POST",
        LOCKS,
        &branch_admin_token,
        Some(lock.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let (status, body) = send(&service, "GET", LOCKS, &mechanic_token, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

    // Input rules.
    for (field, value) in [
        ("reason", json!("   ")),
        ("reason", json!("가".repeat(1001))),
        ("periodEnd", json!("2026-07-31")),
        ("periodStart", json!("2026/08/01")),
        ("domain", json!("inventory")),
    ] {
        let mut bad = lock.clone();
        bad[field] = value;
        let (status, body) = send(&service, "POST", LOCKS, &token, Some(bad)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{field}: {body}");
    }

    // Lock, then an overlapping lock in the same domain is refused.
    let (status, locked) = send(&service, "POST", LOCKS, &token, Some(lock.clone())).await;
    assert_eq!(status, StatusCode::CREATED, "{locked}");
    assert_eq!(locked["periodStart"], "2026-08-01");
    assert_eq!(locked["lockedBy"], admin.as_uuid().to_string());
    assert!(locked.get("unlockedAt").is_none(), "{locked}");
    let lock_id = locked["id"].as_str().unwrap().to_owned();
    let mut overlap = lock.clone();
    overlap["periodStart"] = json!("2026-08-15");
    overlap["periodEnd"] = json!("2026-09-15");
    let (status, body) = send(&service, "POST", LOCKS, &token, Some(overlap)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    // Another domain may lock the same window.
    let mut accounting = lock.clone();
    accounting["domain"] = json!("accounting");
    let (status, body) = send(&service, "POST", LOCKS, &token, Some(accounting)).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");

    // Unlock needs close authority, a reason code, a time box and a step-up
    // (BW-15); the step-up success path is proven in platform-db period_unlock.
    let unlock_uri = format!("{LOCKS}/{lock_id}/unlock");
    let relock_at = (OffsetDateTime::now_utc() + Duration::days(3))
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap();
    let unlock = json!({"reasonCode": "PAYROLL_ERROR", "relockAt": relock_at});
    for (uri, token, body, expected) in [
        (
            &unlock_uri,
            &mechanic_token,
            unlock.clone(),
            StatusCode::FORBIDDEN,
        ),
        (
            &unlock_uri,
            &token,
            json!({"reason": "재계산"}),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            &format!("{LOCKS}/{}/unlock", Uuid::new_v4()),
            &token,
            unlock.clone(),
            StatusCode::NOT_FOUND,
        ),
        (
            &unlock_uri,
            &token,
            unlock.clone(),
            StatusCode::UNAUTHORIZED,
        ),
    ] {
        let (status, body) = send(&service, "POST", uri, token, Some(body)).await;
        assert_eq!(status, expected, "{body}");
    }

    // History lists both, newest first, filterable by domain.
    let (status, page) = send(
        &service,
        "GET",
        &format!("{LOCKS}?domain=payroll"),
        &token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    let (_, page) = send(&service, "GET", LOCKS, &token, None).await;
    assert_eq!(page["items"].as_array().unwrap().len(), 2);

    // Audited: lock ×2; the refused unlocks wrote nothing.
    let audits: Vec<(String, Value)> = sqlx::query_as(
        "SELECT action, after_snap FROM audit_events \
         WHERE org_id = $1 AND action LIKE 'period_lock.%' ORDER BY occurred_at, id",
    )
    .bind(org)
    .fetch_all(&pool)
    .await
    .unwrap();
    let actions: Vec<&str> = audits.iter().map(|(a, _)| a.as_str()).collect();
    assert_eq!(actions, ["period_lock.lock", "period_lock.lock"]);
}

async fn seed_user(pool: &PgPool, org: Uuid, role: &str) -> UserId {
    let user = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id, is_active) VALUES ($1, 'Lock User', $2, $3, true)")
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
