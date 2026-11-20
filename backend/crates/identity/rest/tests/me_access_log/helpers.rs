// SPDX-License-Identifier: LicenseRef-Proprietary
use axum::Router;
use axum::body::{Body, to_bytes};
use console_identity_adapter_postgres::PgOrgStore;
use console_identity_rest::{IdentityRestState, router};
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use console_onboarding_adapter_postgres::PgOnboardingStore;
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use console_platform_db::{DbError, with_audit};
use console_platform_test_support::{issue_session_token, runtime_role_pool};
use http::{Request, StatusCode, header};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::Generate;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use uuid::Uuid;

const TEST_ISSUER: &str = "console-platform-auth";
const TEST_AUDIENCE: &str = "console-api";

pub(crate) struct Harness {
    pub(crate) private_pem: String,
    pub(crate) public_pem: String,
    pub(crate) pool: PgPool,
}

impl Harness {
    pub(crate) async fn new(pool: PgPool) -> Self {
        let signing_key = SigningKey::generate();
        let private_pem = signing_key
            .to_pkcs8_pem(LineEnding::LF)
            .unwrap()
            .to_string();
        let public_pem = signing_key
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap();
        Self {
            private_pem,
            public_pem,
            pool: runtime_role_pool(&pool).await,
        }
    }

    pub(crate) fn service(&self) -> Router {
        let verifier = JwtVerifier::from_es256_public_pem(
            JwtSettings {
                issuer: TEST_ISSUER.to_owned(),
                audience: TEST_AUDIENCE.to_owned(),
                access_token_ttl: Duration::minutes(15),
            },
            self.public_pem.as_bytes(),
        )
        .unwrap();
        router(IdentityRestState::new(
            PgOrgStore::new(self.pool.clone()),
            Some(verifier),
            PgOnboardingStore::new(self.pool.clone()),
        ))
    }

    pub(crate) async fn token(&self, org_id: OrgId, user_id: UserId, platform: bool) -> String {
        let issuer = JwtIssuer::from_es256_pem(
            JwtSettings {
                issuer: TEST_ISSUER.to_owned(),
                audience: TEST_AUDIENCE.to_owned(),
                access_token_ttl: Duration::minutes(15),
            },
            self.private_pem.as_bytes(),
            self.public_pem.as_bytes(),
        )
        .unwrap();
        issue_session_token(
            &self.pool,
            &issuer,
            AccessTokenInput {
                subject: user_id,
                org_id,
                roles: Vec::new(),
                branches: Vec::new(),
                platform,
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
            Vec::new(),
        )
        .await
    }
}

pub(crate) async fn get(harness: &Harness, uri: &str, token: Option<&str>) -> (StatusCode, Value) {
    let mut builder = Request::builder().uri(uri).method("GET");
    if let Some(bearer) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {bearer}"));
    }
    let response = harness
        .service()
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, body)
}

pub(crate) async fn seed_org(pool: &PgPool, org_id: OrgId, slug: &str) {
    let slug = slug.to_owned();
    let event = AuditEvent::new(
        None,
        AuditAction::new("test.seed_org").unwrap(),
        "organization",
        org_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org_id);
    with_audit(pool, event, |tx| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3) \
                 ON CONFLICT (id) DO NOTHING",
            )
            .bind(*org_id.as_uuid())
            .bind(&slug)
            .bind(format!("Test Org {slug}"))
            .execute(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            Ok::<(), DbError>(())
        })
    })
    .await
    .unwrap();
}

pub(crate) async fn seed_user(pool: &PgPool, org_id: OrgId, display_name: &str) -> UserId {
    let user_id = UserId::new();
    let name = display_name.to_owned();
    let event = AuditEvent::new(
        None,
        AuditAction::new("test.seed_user").unwrap(),
        "user",
        user_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org_id);
    with_audit(pool, event, |tx| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)",
            )
            .bind(*user_id.as_uuid())
            .bind(name)
            .bind(Vec::<String>::new())
            .bind(*org_id.as_uuid())
            .execute(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            Ok::<(), DbError>(())
        })
    })
    .await
    .unwrap();
    user_id
}

pub(crate) async fn seed_org_unit(pool: &PgPool, org_id: OrgId, actor: UserId, name: &str) -> Uuid {
    let unit_id = Uuid::new_v4();
    let attrs = json!({ "kind": "department", "name": name });
    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new("test.seed_org_unit").unwrap(),
        "org_unit",
        unit_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org_id);
    with_audit(pool, event, |tx| {
        Box::pin(async move {
            sqlx::query("INSERT INTO org_units (org_id, id) VALUES ($1, $2)")
                .bind(*org_id.as_uuid())
                .bind(unit_id)
                .execute(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)?;
            sqlx::query(
                "INSERT INTO org_unit_revisions \
                 (org_id, org_unit_id, version, command_id, actor_id, payload_digest, attributes, receipt) \
                 VALUES ($1, $2, 1, gen_random_uuid(), $3, decode(repeat('ab', 32), 'hex'), $4, '{}'::jsonb)",
            )
            .bind(*org_id.as_uuid())
            .bind(unit_id)
            .bind(*actor.as_uuid())
            .bind(attrs)
            .execute(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            Ok::<(), DbError>(())
        })
    })
    .await
    .unwrap();
    unit_id
}

pub(crate) async fn seed_employee_link(
    pool: &PgPool,
    org_id: OrgId,
    user_id: UserId,
    number: &str,
    name: &str,
    org_unit_id: Option<Uuid>,
) -> Uuid {
    let employee_id = Uuid::new_v4();
    let number = number.to_owned();
    let name = name.to_owned();
    let event = AuditEvent::new(
        None,
        AuditAction::new("test.seed_employee_link").unwrap(),
        "employee",
        employee_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org_id);
    with_audit(pool, event, |tx| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO employees \
                 (id, org_id, company, name, employee_number, org_unit_id, source_filename, \
                  source_sheet, source_row, source_key, identity_review_required) \
                 VALUES ($1, $2, 'Test Company', $3, $4, $5, 'test.csv', 'employees', 1, $6, false)",
            )
            .bind(employee_id)
            .bind(*org_id.as_uuid())
            .bind(name)
            .bind(&number)
            .bind(org_unit_id)
            .bind(format!("test:{number}"))
            .execute(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            sqlx::query("UPDATE users SET employee_id = $1 WHERE id = $2")
                .bind(employee_id)
                .bind(*user_id.as_uuid())
                .execute(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)?;
            Ok::<(), DbError>(())
        })
    })
    .await
    .unwrap();
    employee_id
}

pub(crate) async fn record_access_audit(
    pool: &PgPool,
    org_id: OrgId,
    actor: UserId,
    action: &str,
    target: (&str, &str),
    occurred_at: OffsetDateTime,
    after_snap: Value,
) {
    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new(action).unwrap(),
        target.0,
        target.1.to_owned(),
        TraceContext::generate(),
        occurred_at,
    )
    .with_org(org_id)
    .with_snapshots(None, Some(after_snap));
    with_audit(pool, event, |_tx| Box::pin(async { Ok::<(), DbError>(()) }))
        .await
        .unwrap();
}
