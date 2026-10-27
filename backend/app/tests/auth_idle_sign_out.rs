#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! INF-03 idle sign-out through the real router as `console_rt`: the request
//! boundary (X-Last-Interaction) and the cookie refresh. The server clock is
//! real, so idleness is set by moving the family's stored activity back.

#[path = "support/http.rs"]
mod support;

use axum::body::{Body, to_bytes};
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, RefreshTokenStore};
use http::{Request, StatusCode, header};
use serde_json::Value;
use sqlx::PgPool;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use uuid::Uuid;

const REFRESH: &str = "/api/v1/auth/token/refresh";
const ME: &str = "/api/v1/users/me";

struct Session {
    owner: PgPool,
    service: axum::Router,
    org: Uuid,
    family: Uuid,
    access: String,
    refresh: String,
}

async fn session(owner: PgPool) -> Session {
    let (org, user) = support::tenant(&owner, &["SUPER_ADMIN"]).await;
    let keys = support::keys();
    let runtime = support::role_pool(&owner, "console_rt", None).await;
    let leave = support::role_pool(&owner, "console_leave_cmd", None).await;
    let service = console_app::build_router(support::app_state(runtime.clone(), leave, &keys));
    let issue = RefreshTokenStore
        .issue_family(
            &runtime,
            *user.as_uuid(),
            OrgId::from_uuid(org),
            OffsetDateTime::now_utc(),
            Duration::days(30),
        )
        .await
        .unwrap();
    console_platform_test_support::seed_session_consent(&owner, issue.family_id).await;
    let issuer = JwtIssuer::from_es256_pem(
        JwtSettings {
            issuer: "console-platform-auth".into(),
            audience: "console-api".into(),
            access_token_ttl: Duration::minutes(15),
        },
        keys.0.as_bytes(),
        keys.1.as_bytes(),
    )
    .unwrap();
    let access = issuer
        .issue_session_access_token(
            input(org, user),
            None,
            vec![],
            issue.family_id,
            issue.expires_at,
        )
        .unwrap();
    Session {
        owner,
        service,
        org,
        family: issue.family_id,
        access,
        refresh: issue.token.as_str().to_owned(),
    }
}

fn input(org: Uuid, user: UserId) -> AccessTokenInput {
    AccessTokenInput {
        subject: user,
        org_id: OrgId::from_uuid(org),
        roles: vec!["SUPER_ADMIN".into()],
        branches: vec![],
        platform: false,
        support: None,
        read_only: false,
        display_name: None,
        feature_grants: vec![],
        authz_subject_version: 0,
        authz_policy_version: 0,
        session_generation: 0,
        issued_at: OffsetDateTime::now_utc(),
    }
}

impl Session {
    /// The server last saw input `ago` (the test's clock), with no snapshot yet.
    async fn idle_for(&self, ago: Duration) {
        sqlx::query(
            "UPDATE auth_refresh_token_families SET last_activity_at = clock_timestamp() - $2, \
             idle_timeout_minutes = NULL WHERE id = $1",
        )
        .bind(self.family)
        .bind(ago)
        .execute(&self.owner)
        .await
        .unwrap();
    }

    async fn activity(&self) -> (OffsetDateTime, Option<i32>, Option<String>) {
        sqlx::query_as(
            "SELECT last_activity_at, idle_timeout_minutes, revoked_reason \
               FROM auth_refresh_token_families WHERE id = $1",
        )
        .bind(self.family)
        .fetch_one(&self.owner)
        .await
        .unwrap()
    }

    async fn tokens(&self) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM auth_refresh_tokens WHERE family_id = $1")
            .bind(self.family)
            .fetch_one(&self.owner)
            .await
            .unwrap()
    }

    async fn me(&self, interaction: Option<OffsetDateTime>) -> StatusCode {
        let mut request =
            Request::get(ME).header(header::AUTHORIZATION, format!("Bearer {}", self.access));
        if let Some(at) = interaction {
            request = request.header("x-last-interaction", at.format(&Rfc3339).unwrap());
        }
        let response = self
            .service
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        response.status()
    }

    /// The browser's cookie refresh: status, error code, and the rotated cookie.
    async fn refresh(&self, token: &str) -> (StatusCode, Option<String>, Option<String>) {
        let request = Request::post(REFRESH)
            .header(header::COOKIE, format!("__Host-console_refresh={token}"))
            .header(header::ORIGIN, "https://auth.example.com")
            .header("sec-fetch-site", "same-origin")
            .header("x-auth-transport", "cookie")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("{}"))
            .unwrap();
        let response = self.service.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .map(|v| v.to_str().unwrap().to_owned());
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (
            status,
            body["error"]["code"].as_str().map(str::to_owned),
            cookie,
        )
    }

    async fn override_minutes(&self, minutes: i64) {
        sqlx::query(
            "INSERT INTO tenant_setting_overrides (org_id, key, value, set_by, reason_code) \
             SELECT $1, 'auth.idle_timeout_minutes', $2, id, 'X' FROM users WHERE org_id = $1",
        )
        .bind(self.org)
        .bind(serde_json::json!(minutes))
        .execute(&self.owner)
        .await
        .unwrap();
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn refresh_while_active_rotates_and_after_the_idle_cutoff_is_refused_with_its_code(
    owner: PgPool,
) {
    let s = session(owner).await;

    // Active (last input 29 of 30 minutes ago): refresh rotates, one new token row.
    s.idle_for(Duration::minutes(29)).await;
    let (status, _, cookie) = s.refresh(&s.refresh).await;
    assert_eq!(status, StatusCode::OK);
    let rotated = cookie
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .strip_prefix("__Host-console_refresh=")
        .unwrap()
        .to_owned();
    assert_ne!(rotated, s.refresh);
    assert_eq!(s.tokens().await, 2);
    assert_eq!(
        s.activity().await.1,
        Some(30),
        "refresh snapshots the tenant value"
    );

    // Idle past the cutoff: refused with session_idle_expired, no token row, no cookie, family ended.
    s.idle_for(Duration::minutes(31)).await;
    let (status, code, cookie) = s.refresh(&rotated).await;
    assert_eq!(
        (status, code.as_deref()),
        (StatusCode::UNAUTHORIZED, Some("session_idle_expired"))
    );
    assert!(cookie.is_none());
    assert_eq!(s.tokens().await, 2, "no new token row");
    assert_eq!(s.activity().await.2.as_deref(), Some("idle_timeout"));
    assert_eq!(
        support::audits(&s.owner, s.org, "auth.session.idle_timeout").await,
        1
    );
    // The ended family keeps saying why, and the old bearer is refused.
    assert_eq!(
        s.refresh(&rotated).await.1.as_deref(),
        Some("session_idle_expired")
    );
    assert_eq!(
        s.me(Some(OffsetDateTime::now_utc())).await,
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn input_keeps_a_session_and_input_after_an_idle_gap_never_revives_it(owner: PgPool) {
    let s = session(owner).await;

    // A request without input never advances activity, even while allowed.
    s.idle_for(Duration::minutes(10)).await;
    let before = s.activity().await.0;
    assert_eq!(s.me(None).await, StatusCode::OK);
    assert_eq!(s.activity().await.0, before);
    // A replayed older interaction never moves it back; a future one is clamped to now.
    assert_eq!(
        s.me(Some(before - Duration::hours(1))).await,
        StatusCode::OK
    );
    assert_eq!(s.activity().await.0, before);
    let sent = OffsetDateTime::now_utc() + Duration::days(1);
    assert_eq!(s.me(Some(sent)).await, StatusCode::OK);
    let (seen, snapshot, _) = s.activity().await;
    // Clamped to the database's now (the test VM's clock may run a few seconds ahead of the host's).
    let limit = OffsetDateTime::now_utc() + Duration::minutes(1);
    assert!(
        seen > before + Duration::minutes(9) && seen < limit,
        "clamped to now: {seen}"
    );
    assert_eq!(snapshot, Some(30));

    // Sliding: input keeps moving it, so 29 + 29 minutes of use outlive the 30-minute timeout.
    s.idle_for(Duration::minutes(29)).await;
    assert_eq!(s.me(Some(OffsetDateTime::now_utc())).await, StatusCode::OK);
    s.idle_for(Duration::minutes(29)).await;
    assert_eq!(s.refresh(&s.refresh).await.0, StatusCode::OK);

    // 31 idle minutes: the first press after it carries `now`, and is still refused.
    s.idle_for(Duration::minutes(31)).await;
    assert_eq!(
        s.me(Some(OffsetDateTime::now_utc())).await,
        StatusCode::UNAUTHORIZED
    );
    assert!(
        s.activity().await.0 < OffsetDateTime::now_utc() - Duration::minutes(30),
        "not revived"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_tenant_value_holds_at_the_floor_and_the_ceiling(owner: PgPool) {
    let s = session(owner).await;
    s.override_minutes(5).await;
    s.idle_for(Duration::minutes(4)).await;
    assert_eq!(s.me(None).await, StatusCode::OK);
    s.idle_for(Duration::minutes(6)).await;
    assert_eq!(s.me(None).await, StatusCode::UNAUTHORIZED);

    let s = session(s.owner).await;
    s.override_minutes(60).await;
    s.idle_for(Duration::minutes(59)).await;
    let (status, _, cookie) = s.refresh(&s.refresh).await;
    assert_eq!(status, StatusCode::OK);
    let rotated = cookie
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .strip_prefix("__Host-console_refresh=")
        .unwrap()
        .to_owned();
    s.idle_for(Duration::minutes(61)).await;
    assert_eq!(
        s.refresh(&rotated).await.1.as_deref(),
        Some("session_idle_expired")
    );
}
