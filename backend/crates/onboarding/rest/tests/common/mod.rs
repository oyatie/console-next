#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use console_kernel_core::{OrgId, TraceContext};
use console_onboarding_adapter_postgres::{OnboardingActor, PgOnboardingStore};
use console_onboarding_rest::{OnboardingRestState, router};
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use console_platform_test_support::{
    issue_session_token, runtime_role_pool, seed_org_and_super_admin,
};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::Value;
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use uuid::Uuid;

pub struct Harness {
    pub app: axum::Router,
    pub actor: OnboardingActor,
    pub token: String,
    owner: PgPool,
    family: Uuid,
}

pub async fn harness(owner: &PgPool, ops: bool) -> Harness {
    let org = OrgId::new();
    let user = seed_org_and_super_admin(owner, *org.as_uuid(), "rest-onboarding").await;
    // rls-arming: ok test fixture marks the real ops holder before console_rt requests.
    sqlx::query("UPDATE users SET is_tenant_ops = true WHERE id = $1")
        .bind(user.as_uuid())
        .execute(owner)
        .await
        .unwrap();
    let user = if ops {
        user
    } else {
        console_platform_test_support::seed_active_user(owner, *org.as_uuid(), "SUPER_ADMIN", "HR")
            .await
    };
    let key = SigningKey::random(&mut OsRng);
    let settings = JwtSettings {
        issuer: "onboarding-test".into(),
        audience: "console-api".into(),
        access_token_ttl: Duration::minutes(15),
    };
    let issuer = JwtIssuer::from_es256_pem(
        settings.clone(),
        key.to_pkcs8_pem(LineEnding::LF).unwrap().as_bytes(),
        key.verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    let verifier = JwtVerifier::from_es256_public_pem(
        settings,
        key.verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    let store = PgOnboardingStore::new(runtime_role_pool(owner).await);
    let token = issue_session_token(
        owner,
        &issuer,
        AccessTokenInput {
            subject: user,
            org_id: org,
            roles: vec!["SUPER_ADMIN".into()],
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
        Vec::new(),
    )
    .await;
    let family = verifier
        .verify_access_token(&token)
        .unwrap()
        .session_family_id
        .unwrap();
    let app = router(OnboardingRestState::new(
        store.clone(),
        Some(verifier),
        Some(console_platform_test_support::soft_passkey::passkey_service()),
    ));
    Harness {
        app,
        actor: OnboardingActor {
            org,
            user,
            roles: vec!["SUPER_ADMIN".into()],
            trace: TraceContext::generate(),
        },
        token,
        owner: owner.clone(),
        family,
    }
}

pub async fn send(h: &Harness, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
    // These cases exercise tenant terms; personal consent follows each published fixture.
    console_platform_test_support::seed_session_consent(&h.owner, h.family).await;
    let r = h
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("Authorization", format!("Bearer {}", h.token))
                .header("Content-Type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = r.status();
    let bytes = to_bytes(r.into_body(), 4 * 1024 * 1024).await.unwrap();
    (
        status,
        if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        },
    )
}

pub async fn state(owner: &PgPool, h: &Harness) -> (i64, i64, String) {
    let choices = sqlx::query_scalar("SELECT count(*) FROM tenant_phase_events WHERE org_id = $1")
        .bind(h.actor.org.as_uuid())
        .fetch_one(owner)
        .await
        .unwrap();
    let acceptances =
        sqlx::query_scalar("SELECT count(*) FROM tenant_terms_acceptances WHERE org_id = $1")
            .bind(h.actor.org.as_uuid())
            .fetch_one(owner)
            .await
            .unwrap();
    let phase = sqlx::query_scalar("SELECT phase FROM tenant_phase WHERE org_id = $1")
        .bind(h.actor.org.as_uuid())
        .fetch_one(owner)
        .await
        .unwrap();
    (choices, acceptances, phase)
}

pub async fn assert_refused(
    owner: &PgPool,
    h: &Harness,
    method: &str,
    path: &str,
    body: Value,
    expected: (StatusCode, &str, Option<&str>),
) {
    let (status, code, remedy) = expected;
    let before = state(owner, h).await;
    let (actual, data) = send(h, method, path, body).await;
    assert_eq!(actual, status, "{data}");
    assert_eq!(data["error"]["code"], code);
    if let Some(remedy) = remedy {
        assert_eq!(data["error"]["reasons"][0], remedy);
    }
    assert_eq!(state(owner, h).await, before);
    let logged: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM audit_events WHERE org_id = $1 AND action = 'tenant.onboarding_refused' AND after_snap->>'code' = $2)").bind(h.actor.org.as_uuid()).bind(code).fetch_one(owner).await.unwrap();
    assert!(logged, "{code} must leave a refusal audit");
}
