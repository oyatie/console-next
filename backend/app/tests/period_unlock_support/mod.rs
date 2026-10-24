//! Shared setup for the BW-15 unlock API tests: a router with a passkey
//! verifier, eligible SUPER_ADMINs with soft passkeys, bound step-ups.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::body::{Body, to_bytes};
use console_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::{
    AccessTokenInput, JwtIssuer, JwtSettings, MobilePasskeyStepUpBinding, MobileStepUpActionKind,
    PasskeyRegistrationStart, PasskeyService,
};
use http::{Request, StatusCode, header};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use url::Url;
use uuid::Uuid;
use webauthn_authenticator_rs::WebauthnAuthenticator;
use webauthn_authenticator_rs::softpasskey::SoftPasskey;

#[path = "../../../test-support/person_fixtures.rs"]
pub mod person_fixtures;

pub const ORIGIN: &str = "https://auth.example.com";
pub const LOCKS: &str = "/api/v1/period-locks";

pub struct Admin {
    pub id: Uuid,
    pub token: String,
    key: WebauthnAuthenticator<SoftPasskey>,
    credential_id: String,
}

/// A SUPER_ADMIN held for 400 days, linked to an employee and notified: an
/// eligible second person (decisions D0.2), with a soft passkey.
pub async fn admin(owner: &PgPool, svc: &PasskeyService, issuer: &JwtIssuer, name: &str) -> Admin {
    admin_in(owner, svc, issuer, OrgId::one(), name).await
}

/// [`admin`] in `org`.
pub async fn admin_in(
    owner: &PgPool,
    svc: &PasskeyService,
    issuer: &JwtIssuer,
    tenant: OrgId,
    name: &str,
) -> Admin {
    let org = *tenant.as_uuid();
    let employee = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO employees (id, org_id, company, name, employee_number, source_filename, \
                                source_sheet, source_row, source_key) \
         VALUES ($1, $2, 'Test Company', $3, $4, 'test.csv', 'employees', 1, $5)",
    )
    .bind(employee)
    .bind(org)
    .bind(name)
    .bind(employee.simple().to_string())
    .bind(format!("test:{employee}"))
    .execute(owner)
    .await
    .unwrap();
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO users (display_name, roles, org_id, employee_id) \
         VALUES ($1, ARRAY['SUPER_ADMIN'], $2, $3) RETURNING id",
    )
    .bind(name)
    .bind(org)
    .bind(employee)
    .fetch_one(owner)
    .await
    .unwrap();
    person_fixtures::bind_user_to_distinct_person(owner, UserId::from_uuid(id)).await;
    for sql in [
        "UPDATE authz_grant_ledger SET occurred_at = now() - interval '400 days' WHERE user_id = $1",
        "INSERT INTO authz_grant_ledger (org_id, user_id, grant_kind, grant_ref, event, source, channel) \
         SELECT org_id, user_id, grant_kind, grant_ref, 'NOTICE_DELIVERED', 'NOTIFIER', 'IN_APP' \
         FROM authz_grant_ledger WHERE user_id = $1 AND grant_kind = 'SYSTEM_ROLE'",
    ] {
        sqlx::query(sql).bind(id).execute(owner).await.unwrap();
    }
    let start = svc
        .start_registration(
            owner,
            tenant,
            PasskeyRegistrationStart {
                user_id: id,
                username: id.to_string(),
                display_name: name.to_owned(),
            },
        )
        .await
        .unwrap();
    let mut challenge = start.challenge;
    if let Some(selection) = challenge.public_key.authenticator_selection.as_mut() {
        selection.require_resident_key = false;
    }
    let mut key = WebauthnAuthenticator::new(SoftPasskey::new(true));
    let credential = key
        .do_registration(Url::parse(ORIGIN).unwrap(), challenge)
        .unwrap();
    let stored = svc
        .finish_registration(owner, tenant, start.ceremony_id, credential)
        .await
        .unwrap();
    let token = session_token(owner, issuer, tenant, id, "SUPER_ADMIN").await;
    Admin {
        id,
        token,
        key,
        credential_id: stored.credential_id,
    }
}

/// A session for `id` in `tenant` holding the legacy `role` only.
pub async fn session_token(
    owner: &PgPool,
    issuer: &JwtIssuer,
    tenant: OrgId,
    id: Uuid,
    role: &str,
) -> String {
    session_token_in_scope(owner, issuer, tenant, id, role, None).await
}

pub async fn session_token_in_scope(
    owner: &PgPool,
    issuer: &JwtIssuer,
    tenant: OrgId,
    id: Uuid,
    role: &str,
    scope: Option<console_kernel_core::AccessScope>,
) -> String {
    console_platform_test_support::issue_session_token(
        owner,
        issuer,
        AccessTokenInput {
            subject: UserId::from_uuid(id),
            org_id: tenant,
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
        scope,
        vec![],
    )
    .await
}

/// A PERIOD_UNLOCK step-up envelope bound to `object_id` and `payload`.
pub async fn step_up(
    owner: &PgPool,
    svc: &PasskeyService,
    who: &mut Admin,
    object_id: Uuid,
    payload: &str,
) -> Value {
    step_up_as(
        owner,
        svc,
        who,
        MobileStepUpActionKind::PeriodUnlock,
        object_id,
        payload,
    )
    .await
}

/// A step-up envelope of `kind` bound to `object_id` and `payload`.
pub async fn step_up_as(
    owner: &PgPool,
    svc: &PasskeyService,
    who: &mut Admin,
    kind: MobileStepUpActionKind,
    object_id: Uuid,
    payload: &str,
) -> Value {
    let binding = MobilePasskeyStepUpBinding::bound(
        kind,
        object_id,
        hex::encode(Sha256::digest(payload.as_bytes())),
    );
    step_up_with_binding(owner, svc, who, binding).await
}

pub async fn step_up_with_binding(
    owner: &PgPool,
    svc: &PasskeyService,
    who: &mut Admin,
    binding: MobilePasskeyStepUpBinding,
) -> Value {
    let start = svc
        .start_mobile_step_up(owner, who.id, binding.clone())
        .await
        .unwrap();
    let mut challenge = serde_json::to_value(start.challenge).unwrap();
    challenge["publicKey"]["allowCredentials"] =
        json!([{"type": "public-key", "id": who.credential_id}]);
    let credential = who
        .key
        .do_authentication(
            Url::parse(ORIGIN).unwrap(),
            serde_json::from_value(challenge).unwrap(),
        )
        .unwrap();
    json!({
        "binding": binding,
        "assertion": { "ceremony_id": start.ceremony_id, "credential": credential },
    })
}

pub async fn send(
    service: &axum::Router,
    uri: &str,
    token: &str,
    key: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method("POST")
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(key) = key {
        builder = builder.header("Idempotency-Key", key);
    }
    let response = service
        .clone()
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(json!({})))
}

pub async fn router(owner: &PgPool) -> (axum::Router, JwtIssuer) {
    let signing = SigningKey::random(&mut OsRng);
    let private_pem = signing.to_pkcs8_pem(LineEnding::LF).unwrap().to_string();
    let public_pem = signing
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let issuer = JwtIssuer::from_es256_pem(
        JwtSettings {
            issuer: "console-platform-auth".to_owned(),
            audience: "console-api".to_owned(),
            access_token_ttl: Duration::minutes(15),
        },
        private_pem.as_bytes(),
        public_pem.as_bytes(),
    )
    .unwrap();
    let config = AppConfig::from_pairs([
        ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ("CONSOLE_JWT_ISSUER", "console-platform-auth".to_owned()),
        ("CONSOLE_JWT_AUDIENCE", "console-api".to_owned()),
        ("CONSOLE_JWT_PUBLIC_KEY_PEM", public_pem),
        ("CONSOLE_JWT_PRIVATE_KEY_PEM", private_pem),
        ("CONSOLE_WEBAUTHN_RP_ID", "example.com".to_owned()),
        ("CONSOLE_WEBAUTHN_RP_ORIGIN", ORIGIN.to_owned()),
    ])
    .unwrap();
    let runtime = console_platform_test_support::runtime_role_pool(owner).await;
    let service =
        build_router(AppState::new(config, DatabaseDependency::Postgres(runtime)).unwrap());
    (service, issuer)
}
