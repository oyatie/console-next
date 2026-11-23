// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::Router;
use axum::body::{Body, to_bytes};
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use console_platform_provisioning::PlatformProvisioner;
use console_platform_rest::{PlatformRestState, router};
use console_platform_test_support::soft_passkey;
use http::{Method, Request, StatusCode, header};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::Generate;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::Value;
use sqlx::{PgPool, postgres::PgPoolOptions};
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use uuid::Uuid;

pub struct Harness {
    private_pem: String,
    public_pem: String,
    rt_pool: PgPool,
}

impl Harness {
    pub async fn new(owner: &PgPool) -> Self {
        let key = SigningKey::generate();
        let options = owner.connect_options().as_ref().clone();
        let rt_pool = PgPoolOptions::new()
            .max_connections(4)
            .after_connect(|conn, _| {
                Box::pin(async move {
                    sqlx::query("SET ROLE console_rt").execute(conn).await?;
                    Ok(())
                })
            })
            .connect_with(options)
            .await
            .unwrap();
        Self {
            private_pem: key.to_pkcs8_pem(LineEnding::LF).unwrap().to_string(),
            public_pem: key
                .verifying_key()
                .to_public_key_pem(LineEnding::LF)
                .unwrap(),
            rt_pool,
        }
    }

    pub fn service(&self) -> Router {
        let verifier = JwtVerifier::from_es256_public_pem(
            JwtSettings {
                issuer: "console-platform-auth".into(),
                audience: "console-api".into(),
                access_token_ttl: Duration::minutes(15),
            },
            self.public_pem.as_bytes(),
        )
        .unwrap();
        router(
            PlatformRestState::new(
                self.rt_pool.clone(),
                Some(verifier),
                PlatformProvisioner::new(Duration::minutes(15)),
            )
            .with_passkey_step_up(Some(soft_passkey::passkey_service())),
        )
    }

    pub async fn token(
        &self,
        user_id: UserId,
        org_id: OrgId,
        platform: bool,
        roles: Vec<String>,
    ) -> String {
        let issuer = JwtIssuer::from_es256_pem(
            JwtSettings {
                issuer: "console-platform-auth".into(),
                audience: "console-api".into(),
                access_token_ttl: Duration::minutes(15),
            },
            self.private_pem.as_bytes(),
            self.public_pem.as_bytes(),
        )
        .unwrap();
        console_platform_test_support::issue_session_token(
            &self.rt_pool,
            &issuer,
            AccessTokenInput {
                subject: user_id,
                org_id,
                roles,
                branches: vec![],
                platform,
                support: None,
                read_only: false,
                display_name: None,
                feature_grants: vec![],
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
}

pub async fn call(
    service: &Router,
    method: Method,
    path: String,
    token: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header(header::AUTHORIZATION, format!("Bearer {token}"));
    if body.is_some() {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
    }
    let resp = service
        .clone()
        .oneshot(
            builder
                .body(Body::from(body.map_or_else(String::new, |v| v.to_string())))
                .unwrap(),
        )
        .await
        .unwrap();
    let st = resp.status();
    let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let json = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (st, json)
}

pub async fn seed_user(pool: &PgPool, org: OrgId, roles: Vec<String>) -> UserId {
    sqlx::query("INSERT INTO organizations (id, slug, name, status) VALUES ($1, 'platform', 'Platform', 'ARCHIVED') ON CONFLICT (id) DO NOTHING")
        .bind(*OrgId::platform().as_uuid())
        .execute(pool)
        .await
        .unwrap();
    let id = UserId::new();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, 'Test User', $2, $3)",
    )
    .bind(*id.as_uuid())
    .bind(roles)
    .bind(*org.as_uuid())
    .execute(pool)
    .await
    .unwrap();
    id
}

pub async fn seed_org(pool: &PgPool, slug: &str, status: &str) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO organizations (slug, name, status) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(format!(
        "{slug}-{}",
        &Uuid::new_v4().simple().to_string()[..8]
    ))
    .bind(format!("Org {slug}"))
    .bind(status)
    .fetch_one(pool)
    .await
    .unwrap()
}
