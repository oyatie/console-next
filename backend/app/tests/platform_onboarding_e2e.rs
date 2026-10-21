#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! End-to-end proof of the PLATFORM tier + tenant onboarding, running as the
//! genuine NON-OWNER runtime role `console_rt` (so RLS is actually enforced, exactly
//! as in production).
//!
//! Assertions (definition of done):
//!   1. A PLATFORM token can POST /api/platform/orgs to onboard tenant "acme",
//!      creating the org + its first SUPER_ADMIN + a one-time OTP.
//!   2. TENANT ISOLATION: a JWT scoped to acme reading /api/v1/users sees ONLY
//!      acme's users (never SAE's), and a SAE-scoped JWT sees only SAE's — under
//!      `console_rt`, so RLS is the gate.
//!   3. A TENANT token is REJECTED on /api/platform/* (403).
//!   4. A PLATFORM token is REJECTED on a tenant /api/v1/* route (403).

use axum::body::{Body, to_bytes};
use console_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use console_kernel_core::{BranchId, OrgId, UserId};
use console_platform_auth::{
    AccessTokenInput, JwtIssuer, JwtSettings, PasskeyRegistrationStart, PasskeyService,
    WebauthnSettings,
};
use http::{Request, StatusCode, header};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use url::Url;
use webauthn_authenticator_rs::prelude::{
    CreationChallengeResponse, RequestChallengeResponse, WebauthnAuthenticator,
};
use webauthn_authenticator_rs::softpasskey::SoftPasskey;

const TEST_ISSUER: &str = "console-platform-auth";
const TEST_AUDIENCE: &str = "console-api";
const TEST_RP_ID: &str = "example.com";
const TEST_ORIGIN: &str = "https://auth.example.com";

struct Keys {
    private_pem: String,
    public_pem: String,
}

fn gen_keys() -> Keys {
    let signing_key = SigningKey::random(&mut OsRng);
    Keys {
        private_pem: signing_key
            .to_pkcs8_pem(LineEnding::LF)
            .unwrap()
            .to_string(),
        public_pem: signing_key
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap(),
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn platform_onboards_tenant_and_rls_isolates(super_pool: PgPool) {
    let keys = gen_keys();

    // Seed SAE (tenant #1) + a SAE admin as the OWNER (bypasses RLS for setup).
    let sae = OrgId::one();
    let sae_admin = UserId::new();
    seed_tenant(&super_pool, sae, "sae", sae_admin).await;

    // The app pool connects as the non-owner runtime role, so RLS is enforced.
    let runtime_pool = console_rt_pool(&super_pool).await;
    let service = build_router(app_state(runtime_pool.clone(), &keys));

    // --- (1) PLATFORM token onboards a NEW tenant "acme" -----------------------
    // Seed the platform admin user (homed in the sentinel org) so the onboarding
    // audit's actor FK resolves. Migration 0036 creates the sentinel org row.
    let platform_admin = UserId::new();
    let mut admin_key = seed_platform_admin(&super_pool, platform_admin).await;
    let platform_token = issue_token(
        &runtime_pool,
        &keys,
        platform_admin,
        OrgId::platform(),
        vec!["SUPER_ADMIN".to_owned()],
        true,
    )
    .await;

    let response = service
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/platform/orgs")
                .header(header::AUTHORIZATION, format!("Bearer {platform_token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"slug":"acme","name":"Acme Inc"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(
        status,
        StatusCode::CREATED,
        "platform admin should onboard a tenant; body={}",
        String::from_utf8_lossy(&body)
    );
    let onboarding: Value = serde_json::from_slice(&body).unwrap();
    let acme_id = onboarding["org"]["id"].as_str().unwrap().to_owned();
    let acme_admin_id = onboarding["admin_user_id"].as_str().unwrap().to_owned();
    assert!(
        onboarding["otp"].as_str().is_some_and(|s| !s.is_empty()),
        "onboarding must return a one-time OTP: {onboarding}"
    );
    let acme_org = OrgId::from_uuid(acme_id.parse().unwrap());

    // --- (2) TENANT ISOLATION under console_rt -------------------------------------
    // The acme admin token reads /api/v1/users → sees ONLY acme's admin, never SAE.
    let acme_admin = UserId::from_uuid(acme_admin_id.parse().unwrap());
    let acme_token = issue_token(
        &runtime_pool,
        &keys,
        acme_admin,
        acme_org,
        vec!["SUPER_ADMIN".to_owned()],
        false,
    )
    .await;
    let acme_users = read_users(&service, &acme_token).await;
    assert!(
        acme_users
            .iter()
            .any(|u| u["id"].as_str() == Some(acme_admin_id.as_str())),
        "acme must see its own admin: {acme_users:?}"
    );
    assert!(
        !acme_users
            .iter()
            .any(|u| u["id"].as_str() == Some(&sae_admin.to_string())),
        "acme must NOT see SAE's admin (cross-tenant leak): {acme_users:?}"
    );

    // The SAE admin token sees ONLY SAE's admin, never acme's.
    let sae_token = issue_token(
        &runtime_pool,
        &keys,
        sae_admin,
        sae,
        vec!["SUPER_ADMIN".to_owned()],
        false,
    )
    .await;
    let sae_users = read_users(&service, &sae_token).await;
    assert!(
        sae_users
            .iter()
            .any(|u| u["id"].as_str() == Some(&sae_admin.to_string())),
        "SAE must see its own admin: {sae_users:?}"
    );
    assert!(
        !sae_users
            .iter()
            .any(|u| u["id"].as_str() == Some(acme_admin_id.as_str())),
        "SAE must NOT see acme's admin (cross-tenant leak): {sae_users:?}"
    );

    // --- (3) TENANT token REJECTED on /api/platform/* --------------------------
    let response = service
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/platform/orgs")
                .header(header::AUTHORIZATION, format!("Bearer {sae_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::FORBIDDEN,
        "a tenant token must be rejected on /api/platform/* (tier crossing)"
    );

    // --- (4) PLATFORM token REJECTED on a tenant /api/v1/* route ---------------
    let response = service
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/users")
                .header(header::AUTHORIZATION, format!("Bearer {platform_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::FORBIDDEN,
        "a platform token must be rejected on tenant /api/* routes (tier crossing)"
    );

    // --- (5) GET /api/platform/orgs lists acme + sae (cross-tenant read) -------
    let response = service
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/platform/orgs")
                .header(header::AUTHORIZATION, format!("Bearer {platform_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let listing: Value = serde_json::from_slice(&body).unwrap();
    let slugs: Vec<&str> = listing
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|o| o["slug"].as_str())
        .collect();
    assert!(slugs.contains(&"acme"), "list must include acme: {slugs:?}");
    // acme and tenant #1, whose seeded slug (legacy migration 0028) differs between the private and public trees.
    assert_eq!(slugs.len(), 2, "acme + tenant #1: {slugs:?}");
    assert!(
        !slugs.contains(&"platform"),
        "list must NOT include the platform sentinel: {slugs:?}"
    );

    // --- (5b) Reissue the tenant admin's lost/expired onboarding code ---------
    // Every reissue carries a fresh step-up assertion of the operator's passkey.
    let send_reissue = |org_id: String, body: Value| {
        let service = service.clone();
        let token = platform_token.clone();
        async move {
            let response = service
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(format!("/api/platform/orgs/{org_id}/admin-otp"))
                        .header(header::AUTHORIZATION, format!("Bearer {token}"))
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            let status = response.status();
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            (
                status,
                serde_json::from_slice::<Value>(&body).unwrap_or(Value::Null),
            )
        }
    };
    // A platform token alone (no step-up) mints nothing.
    let (status, refused) = send_reissue(acme_id.clone(), json!({})).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{refused}");
    let open_before: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM auth_bootstrap_credentials WHERE user_id = $1 AND revoked_reason = 'reissued'",
    )
    .bind(*acme_admin.as_uuid())
    .fetch_one(&super_pool)
    .await
    .unwrap();
    assert_eq!(open_before, 0, "a refused reissue revokes nothing");
    let (status, reissued) = send_reissue(
        acme_id.clone(),
        json!({ "step_up": admin_key.step_up(&super_pool).await }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "reissue: {reissued}");
    assert_eq!(
        reissued["admin_user_id"].as_str(),
        Some(acme_admin_id.as_str())
    );
    let new_otp = reissued["otp"].as_str().unwrap();
    assert!(!new_otp.is_empty() && Some(new_otp) != onboarding["otp"].as_str());
    let (open, reissued_rows): (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE consumed_at IS NULL AND revoked_at IS NULL), \
                count(*) FILTER (WHERE revoked_reason = 'reissued') \
         FROM auth_bootstrap_credentials WHERE user_id = $1",
    )
    .bind(*acme_admin.as_uuid())
    .fetch_one(&super_pool)
    .await
    .unwrap();
    assert_eq!(
        (open, reissued_rows),
        (1, 1),
        "only the new code stays open"
    );
    let audited: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events \
         WHERE action = 'platform.tenant.admin_otp.reissue' AND org_id = $1",
    )
    .bind(*acme_org.as_uuid())
    .fetch_one(&super_pool)
    .await
    .unwrap();
    assert_eq!(audited, 1);
    let (status, _) = send_reissue(
        uuid::Uuid::new_v4().to_string(),
        json!({ "step_up": admin_key.step_up(&super_pool).await }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "unknown tenant");
    let (status, _) = send_reissue(
        acme_id.clone(),
        json!({ "step_up": admin_key.step_up(&super_pool).await }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "reissue again while not enrolled");
    // Once the admin enrolled a passkey, the platform can no longer mint codes.
    console_platform_test_support::seed_passkey(&super_pool, acme_org, acme_admin).await;
    let (status, refused) = send_reissue(
        acme_id.clone(),
        json!({ "step_up": admin_key.step_up(&super_pool).await }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["code"], "admin_already_enrolled");
    // Past onboarding stays past onboarding: another SUPER_ADMIN's passkey,
    // or the first admin's earlier registration (its passkey since reset),
    // still refuses the vendor reissue.
    sqlx::query("DELETE FROM auth_webauthn_credentials WHERE user_id = $1")
        .bind(*acme_admin.as_uuid())
        .execute(&super_pool)
        .await
        .unwrap();
    let second_admin = UserId::new();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id, is_active) \
         VALUES ($1, 'Second Admin', ARRAY['SUPER_ADMIN'], $2, true)",
    )
    .bind(*second_admin.as_uuid())
    .bind(*acme_org.as_uuid())
    .execute(&super_pool)
    .await
    .unwrap();
    console_platform_test_support::seed_passkey(&super_pool, acme_org, second_admin).await;
    let (status, refused) = send_reissue(
        acme_id.clone(),
        json!({ "step_up": admin_key.step_up(&super_pool).await }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "another admin enrolled: {refused}"
    );
    sqlx::query("DELETE FROM auth_webauthn_credentials WHERE user_id = $1")
        .bind(*second_admin.as_uuid())
        .execute(&super_pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO audit_events (actor, action, target_type, target_id, trace_id, span_id, occurred_at, org_id) \
         VALUES ($1, 'auth.passkey.register', 'auth_webauthn_credential', gen_random_uuid()::text, \
                 repeat('a', 32), repeat('b', 16), now(), $2)",
    )
    .bind(*acme_admin.as_uuid())
    .bind(*acme_org.as_uuid())
    .execute(&super_pool)
    .await
    .unwrap();
    let (status, refused) = send_reissue(
        acme_id.clone(),
        json!({ "step_up": admin_key.step_up(&super_pool).await }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "admin enrolled before a reset: {refused}"
    );
    assert_eq!(refused["error"]["code"], "admin_already_enrolled");

    // --- (6) PATCH /api/platform/orgs/{id} suspends acme -----------------------
    let response = service
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/platform/orgs/{acme_id}"))
                .header(header::AUTHORIZATION, format!("Bearer {platform_token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"status":"SUSPENDED"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(
        status,
        StatusCode::OK,
        "PATCH should suspend; body={}",
        String::from_utf8_lossy(&body)
    );
    let patched: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(patched["status"].as_str(), Some("SUSPENDED"));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn read_users(service: &axum::Router, token: &str) -> Vec<Value> {
    let response = service
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/users")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "authenticated tenant read should succeed under console_rt"
    );
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();
    json.get("users")
        .or_else(|| json.get("items"))
        .and_then(Value::as_array)
        .or_else(|| json.as_array())
        .cloned()
        .expect("response should contain a user array")
}

async fn console_rt_pool(super_pool: &PgPool) -> PgPool {
    // Preserve the SQLx per-test database, Unix socket and TLS options together.
    let options = super_pool.connect_options().as_ref().clone();
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
        .expect("failed to build console_rt runtime pool")
}

async fn seed_tenant(pool: &PgPool, org: OrgId, slug: &str, admin_id: UserId) {
    let org_uuid = *org.as_uuid();
    sqlx::query(
        "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3) \
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(org_uuid)
    .bind(slug)
    .bind(slug.to_uppercase())
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO users (id, display_name, roles, is_active, org_id) \
         VALUES ($1, $2, $3, true, $4)",
    )
    .bind(*admin_id.as_uuid())
    .bind(format!("{slug} Admin"))
    .bind(vec!["SUPER_ADMIN".to_string()])
    .bind(org_uuid)
    .execute(pool)
    .await
    .unwrap();
}

/// Seed a platform admin user in the platform sentinel org (created by 0036).
/// The platform operator's real (soft) passkey, for fresh step-up assertions.
struct PlatformKey {
    authenticator: WebauthnAuthenticator<SoftPasskey>,
    credential_id: String,
}

impl PlatformKey {
    /// A fresh `{ ceremony_id, credential }` step-up assertion.
    async fn step_up(&mut self, pool: &PgPool) -> Value {
        let ceremony = passkey_service().start_authentication(pool).await.unwrap();
        let mut challenge = serde_json::to_value(&ceremony.challenge).unwrap();
        // SoftPasskey has no resident-key store: name the credential it holds.
        challenge["publicKey"]["allowCredentials"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "type": "public-key", "id": self.credential_id }));
        let challenge: RequestChallengeResponse = serde_json::from_value(challenge).unwrap();
        let credential = self
            .authenticator
            .do_authentication(Url::parse(TEST_ORIGIN).unwrap(), challenge)
            .unwrap();
        json!({ "ceremony_id": ceremony.ceremony_id, "credential": credential })
    }
}

fn passkey_service() -> PasskeyService {
    PasskeyService::new(WebauthnSettings {
        rp_id: TEST_RP_ID.to_owned(),
        rp_origin: Url::parse(TEST_ORIGIN).unwrap(),
        rp_name: "Console".to_owned(),
        extra_allowed_origins: vec![],
        ceremony_ttl: Duration::minutes(5),
    })
    .unwrap()
}

async fn seed_platform_admin(pool: &PgPool, admin_id: UserId) -> PlatformKey {
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, is_active, org_id) \
         VALUES ($1, 'Platform Admin', $2, true, \
                 '00000000-0000-0000-0000-00000000face'::uuid)",
    )
    .bind(*admin_id.as_uuid())
    .bind(vec!["SUPER_ADMIN".to_string()])
    .execute(pool)
    .await
    .unwrap();
    // Onboarding is refused (403 passkey_required) for OTP-only sessions, and
    // code reissue needs a fresh assertion: enroll a real soft passkey.
    let service = passkey_service();
    let registration = service
        .start_registration(
            pool,
            OrgId::platform(),
            PasskeyRegistrationStart {
                user_id: *admin_id.as_uuid(),
                username: "platform.admin".to_owned(),
                display_name: "Platform Admin".to_owned(),
            },
        )
        .await
        .unwrap();
    let mut challenge: CreationChallengeResponse = registration.challenge;
    if let Some(selection) = challenge.public_key.authenticator_selection.as_mut() {
        selection.require_resident_key = false;
    }
    let mut authenticator = WebauthnAuthenticator::new(SoftPasskey::new(true));
    let credential = authenticator
        .do_registration(Url::parse(TEST_ORIGIN).unwrap(), challenge)
        .unwrap();
    let stored = service
        .finish_registration(
            pool,
            OrgId::platform(),
            registration.ceremony_id,
            credential,
        )
        .await
        .unwrap();
    PlatformKey {
        authenticator,
        credential_id: stored.credential_id,
    }
}

fn app_state(pool: PgPool, keys: &Keys) -> AppState {
    let config = AppConfig::from_pairs([
        ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ("CONSOLE_JWT_ISSUER", TEST_ISSUER.to_owned()),
        ("CONSOLE_JWT_AUDIENCE", TEST_AUDIENCE.to_owned()),
        ("CONSOLE_JWT_PRIVATE_KEY_PEM", keys.private_pem.clone()),
        ("CONSOLE_JWT_PUBLIC_KEY_PEM", keys.public_pem.clone()),
        ("CONSOLE_WEBAUTHN_RP_ID", TEST_RP_ID.to_owned()),
        ("CONSOLE_WEBAUTHN_RP_ORIGIN", TEST_ORIGIN.to_owned()),
        ("CONSOLE_WEBAUTHN_RP_NAME", "Console".to_owned()),
    ])
    .unwrap();
    AppState::new(config, DatabaseDependency::Postgres(pool)).unwrap()
}

async fn issue_token(
    pool: &PgPool,
    keys: &Keys,
    user_id: UserId,
    org: OrgId,
    roles: Vec<String>,
    platform: bool,
) -> String {
    let settings = JwtSettings {
        issuer: TEST_ISSUER.to_owned(),
        audience: TEST_AUDIENCE.to_owned(),
        access_token_ttl: Duration::minutes(15),
    };
    let issuer = JwtIssuer::from_es256_pem(
        settings,
        keys.private_pem.as_bytes(),
        keys.public_pem.as_bytes(),
    )
    .unwrap();
    console_platform_test_support::issue_session_token(
        pool,
        &issuer,
        AccessTokenInput {
            subject: user_id,
            org_id: org,
            roles,
            branches: Vec::<BranchId>::new(),
            platform,
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
