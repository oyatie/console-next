//! MR-21: `PATCH /api/platform/orgs/{id}` renames a tenant (name, slug) and
//! keeps changing its status; slug errors are 409 `slug_taken` / 422
//! `slug_invalid` with `field: "slug"` on create and rename (BW-25). The router
//! runs on a `console_rt` pool, so the SECURITY DEFINER path is what is tested.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::Router;
use axum::body::{Body, to_bytes};
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use console_platform_provisioning::PlatformProvisioner;
use console_platform_rest::{PLATFORM_ORGS_PATH, PlatformRestState, router};
use console_platform_test_support::soft_passkey::{self, SoftKey};
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

fn settings() -> JwtSettings {
    JwtSettings {
        issuer: "console-platform-auth".to_owned(),
        audience: "console-api".to_owned(),
        access_token_ttl: Duration::minutes(15),
    }
}

pub(super) struct Harness {
    pub(super) service: Router,
    token: String,
    issuer: JwtIssuer,
    pub(super) owner: PgPool,
    key: tokio::sync::Mutex<SoftKey>,
}

impl Harness {
    pub(super) async fn new(owner: PgPool) -> Self {
        let key = SigningKey::random(&mut OsRng);
        let private_pem = key.to_pkcs8_pem(LineEnding::LF).unwrap().to_string();
        let public_pem = key
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap();
        let options = owner.connect_options().as_ref().clone();
        let rt = PgPoolOptions::new()
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
        let admin = UserId::new();
        sqlx::query("INSERT INTO organizations (id, slug, name, status) VALUES ($1, 'platform', 'Platform', 'ARCHIVED') ON CONFLICT (id) DO NOTHING")
            .bind(*OrgId::platform().as_uuid())
            .execute(&owner)
            .await
            .unwrap();
        sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, 'Platform Admin', $2, $3)")
            .bind(*admin.as_uuid())
            .bind(vec!["SUPER_ADMIN".to_owned()])
            .bind(*OrgId::platform().as_uuid())
            .execute(&owner)
            .await
            .unwrap();
        let key = SoftKey::enroll(&owner, OrgId::platform(), admin).await;
        let issuer =
            JwtIssuer::from_es256_pem(settings(), private_pem.as_bytes(), public_pem.as_bytes())
                .unwrap();
        let token = console_platform_test_support::issue_session_token(
            &rt,
            &issuer,
            AccessTokenInput {
                subject: admin,
                org_id: OrgId::platform(),
                roles: vec!["SUPER_ADMIN".to_owned()],
                branches: vec![],
                platform: true,
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
        .await;
        let verifier =
            JwtVerifier::from_es256_public_pem(settings(), public_pem.as_bytes()).unwrap();
        let service = router(
            PlatformRestState::new(
                rt,
                Some(verifier),
                PlatformProvisioner::new(Duration::minutes(15)),
            )
            .with_passkey_step_up(Some(soft_passkey::passkey_service())),
        );
        Self {
            service,
            token,
            issuer,
            owner,
            key: tokio::sync::Mutex::new(key),
        }
    }

    pub(super) async fn send(&self, method: &str, uri: &str, body: Value) -> (StatusCode, Value) {
        self.send_as(method, uri, body, &self.token).await
    }

    pub(super) async fn send_with_key(
        &self,
        method: &str,
        uri: &str,
        body: Value,
        key: Option<&str>,
    ) -> (StatusCode, Value) {
        self.send_as_with_key(method, uri, body, &self.token, key)
            .await
    }

    pub(super) async fn send_as(
        &self,
        method: &str,
        uri: &str,
        body: Value,
        token: &str,
    ) -> (StatusCode, Value) {
        let key = (method == "POST" && uri == console_platform_rest::TENANT_DOMAIN_REQUEST_PATH)
            .then(|| format!("domain-request-{}", Uuid::new_v4()));
        self.send_as_with_key(method, uri, body, token, key.as_deref())
            .await
    }

    pub(super) async fn send_as_with_key(
        &self,
        method: &str,
        uri: &str,
        body: Value,
        token: &str,
        key: Option<&str>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder();
        if let Some(key) = key {
            request = request.header("Idempotency-Key", key);
        }
        let request = request
            .method(method)
            .uri(uri)
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let response = self.service.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    pub(super) async fn onboard(&self, slug: &str) -> Uuid {
        let (status, body) = self
            .send(
                "POST",
                PLATFORM_ORGS_PATH,
                json!({ "slug": slug, "name": format!("Tenant {slug}") }),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        body["org"]["id"].as_str().unwrap().parse().unwrap()
    }

    pub(super) async fn patch(&self, id: Uuid, mut body: Value) -> (StatusCode, Value) {
        if body.get("slug").is_some() {
            body["step_up"] = self.key.lock().await.step_up(&self.owner).await;
        }
        self.send("PATCH", &format!("{PLATFORM_ORGS_PATH}/{id}"), body)
            .await
    }

    pub(super) async fn token_for(
        &self,
        user: UserId,
        org: OrgId,
        platform: bool,
        roles: Vec<String>,
    ) -> String {
        let rt = console_platform_test_support::runtime_role_pool(&self.owner).await;
        console_platform_test_support::issue_session_token(
            &rt,
            &self.issuer,
            AccessTokenInput {
                subject: user,
                org_id: org,
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

    /// Owner reads with RLS off, so the assertion sees the stored row.
    pub(super) async fn read<T: Send + Unpin + for<'r> sqlx::FromRow<'r, sqlx::postgres::PgRow>>(
        &self,
        sql: &'static str,
        id: Uuid,
    ) -> T {
        let mut tx = self.owner.begin().await.unwrap();
        sqlx::query("SET LOCAL row_security = off")
            .execute(&mut *tx)
            .await
            .unwrap();
        let row = sqlx::query_as(sql)
            .bind(id)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        row
    }

    pub(super) async fn org(&self, id: Uuid) -> (String, String, String) {
        self.read(
            "SELECT slug, name, status FROM organizations WHERE id = $1",
            id,
        )
        .await
    }
}
