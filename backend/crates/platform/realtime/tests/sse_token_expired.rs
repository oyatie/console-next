//! `GET /api/v1/events` with an access token past its `exp` answers 401
//! `token_expired` (the stream's expected end: the client renews), tagged
//! `error_type` for the HTTP metrics; a forged or garbled token stays
//! `unauthorized`.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use console_kernel_core::{ErrorType, OrgId};
use console_platform_auth::{
    AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier, RefreshTokenStore,
};
use console_platform_realtime::sse::{SseConfig, SseState, router};
use console_platform_realtime::{
    PgRealtimeHub, RealtimeHubConfig, RealtimeRestState, TOKEN_EXPIRED,
};
use console_platform_test_support::{runtime_role_pool, seed_branch, seed_user};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::Value;
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;

async fn refusal(sse: &SseState, token: &str) -> (StatusCode, Option<ErrorType>, Value) {
    let request = Request::get("/api/v1/events")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let response = router(sse.clone()).oneshot(request).await.unwrap();
    let status = response.status();
    let tagged = response.extensions().get::<ErrorType>().copied();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, tagged, serde_json::from_slice(&body).unwrap())
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_expired_access_token_is_refused_as_token_expired(owner: PgPool) {
    let org = OrgId::one();
    let branch = seed_branch(&owner, "rt-sse-exp", "rt-sse-exp").await;
    let user = seed_user(&owner, "Reader", "SUPER_ADMIN", branch).await;
    let runtime = runtime_role_pool(&owner).await;
    let key = SigningKey::random(&mut OsRng);
    let private = key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public = key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let settings = JwtSettings {
        issuer: "rt-sse-exp".into(),
        audience: "rt-sse-exp".into(),
        access_token_ttl: Duration::seconds(2),
    };
    let issuer =
        JwtIssuer::from_es256_pem(settings.clone(), private.as_bytes(), public.as_bytes()).unwrap();
    let verifier = JwtVerifier::from_es256_public_pem(settings, public.as_bytes()).unwrap();
    let now = OffsetDateTime::now_utc();
    let family = RefreshTokenStore
        .issue_family(&runtime, *user.as_uuid(), org, now, Duration::hours(1))
        .await
        .unwrap();
    // A valid session's token with a 2-second life (the issuer never mints an expired one), then past it.
    let input = AccessTokenInput {
        subject: user,
        org_id: org,
        roles: vec!["SUPER_ADMIN".into()],
        branches: vec![branch],
        platform: false,
        view_as: false,
        read_only: false,
        display_name: None,
        feature_grants: vec![],
        authz_subject_version: 0,
        authz_policy_version: 0,
        session_generation: 0,
        issued_at: now,
    };
    let expired = issuer
        .issue_session_access_token(input, None, vec![], family.family_id, family.expires_at)
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    let hub = Arc::new(PgRealtimeHub::new(runtime, RealtimeHubConfig::default()));
    let sse = SseState::new(
        RealtimeRestState::new(hub, Some(verifier)),
        SseConfig::default(),
    );

    let (status, tagged, body) = refusal(&sse, &expired).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["code"], "token_expired");
    assert_eq!(tagged, Some(ErrorType(TOKEN_EXPIRED)));

    // Not every 401 is an expiry: a garbled token is refused as before.
    let (status, tagged, body) = refusal(&sse, "not-a-jwt").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["code"], "unauthorized");
    assert_eq!(tagged, Some(ErrorType("unauthorized")));
}
