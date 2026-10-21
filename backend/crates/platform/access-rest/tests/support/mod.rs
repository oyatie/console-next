//! One tenant for the access suites: an ops account and two HR workers, all
//! with NO legacy role (AX-0), 법인 A and B each with one 사업장 and branch,
//! tokens, a soft passkey for the ops account, and the face's router over the
//! `console_rt` pool (RLS applies).
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::net::SocketAddr;

use axum::body::{Body, to_bytes};
use axum::extract::ConnectInfo;
use axum::http::{Method, Request, StatusCode, header};
use console_kernel_core::{OrgId, UserId};
use console_platform_access::AccessService;
use console_platform_access_rest::{AccessRestState, router};
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use console_platform_test_support::soft_passkey::{SoftKey, passkey_service};
use console_platform_test_support::{issue_session_token, runtime_role_pool};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use uuid::Uuid;

pub struct World {
    pub owner: PgPool,
    pub rt: PgPool,
    pub org: Uuid,
    pub ops: UserId,
    pub hr: UserId,
    pub hr2: UserId,
    pub le_a: Uuid,
    pub le_b: Uuid,
    pub wp_a: Uuid,
    pub wp_b: Uuid,
    pub branch_a: Uuid,
    pub branch_b: Uuid,
    pub issuer: JwtIssuer,
    pub verifier: JwtVerifier,
    pub ops_key: SoftKey,
    pub hr_key: SoftKey,
}

fn settings() -> JwtSettings {
    JwtSettings {
        issuer: "console-platform-auth".to_owned(),
        audience: "console-api".to_owned(),
        access_token_ttl: Duration::minutes(15),
    }
}

async fn exec(pool: &PgPool, sql: &str, binds: &[Uuid]) {
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.to_owned()));
    for b in binds {
        q = q.bind(*b);
    }
    q.execute(pool).await.unwrap();
}

async fn user(pool: &PgPool, org: Uuid, name: &str, ops: bool) -> UserId {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id, is_tenant_ops) VALUES ($1, $2, '{}', $3, $4)",
    )
    .bind(id)
    .bind(name)
    .bind(org)
    .bind(ops)
    .execute(pool)
    .await
    .unwrap();
    UserId::from_uuid(id)
}

async fn site(pool: &PgPool, org: Uuid, le: Uuid) -> (Uuid, Uuid) {
    let region = Uuid::new_v4();
    let branch = Uuid::new_v4();
    let wp = Uuid::new_v4();
    exec(
        pool,
        "INSERT INTO regions (id, name, org_id) VALUES ($1, $2::text, $3)",
        &[region, region, org],
    )
    .await;
    exec(
        pool,
        "INSERT INTO branches (id, region_id, name, org_id) VALUES ($1, $2, $1::text, $3)",
        &[branch, region, org],
    )
    .await;
    exec(
        pool,
        "INSERT INTO workplaces (org_id, id, legal_entity_id, default_branch_id, created_change_mode) \
         VALUES ($1, $2, $3, $4, 'MIGRATION')",
        &[org, wp, le, branch],
    )
    .await;
    (wp, branch)
}

pub async fn world(owner: PgPool) -> World {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'Access pilot')")
        .bind(org)
        .bind(format!("acc-{}", &org.simple().to_string()[..12]))
        .execute(&owner)
        .await
        .unwrap();
    let ops = user(&owner, org, "운영 계정", true).await;
    let hr = user(&owner, org, "김인사", false).await;
    let hr2 = user(&owner, org, "이노무", false).await;
    let (le_a, le_b) = (Uuid::new_v4(), Uuid::new_v4());
    for le in [le_a, le_b] {
        exec(
            &owner,
            "INSERT INTO legal_entities (org_id, id, needs_confirmation, created_change_mode) \
             VALUES ($1, $2, true, 'MIGRATION')",
            &[org, le],
        )
        .await;
    }
    let (wp_a, branch_a) = site(&owner, org, le_a).await;
    let (wp_b, branch_b) = site(&owner, org, le_b).await;
    let key = SigningKey::random(&mut OsRng);
    let private_pem = key.to_pkcs8_pem(LineEnding::LF).unwrap().to_string();
    let public_pem = key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let issuer =
        JwtIssuer::from_es256_pem(settings(), private_pem.as_bytes(), public_pem.as_bytes())
            .unwrap();
    let verifier = JwtVerifier::from_es256_public_pem(settings(), public_pem.as_bytes()).unwrap();
    let ops_key = SoftKey::enroll(&owner, OrgId::from_uuid(org), ops).await;
    let hr_key = SoftKey::enroll(&owner, OrgId::from_uuid(org), hr).await;
    let rt = runtime_role_pool(&owner).await;
    World {
        owner,
        rt,
        org,
        ops,
        hr,
        hr2,
        le_a,
        le_b,
        wp_a,
        wp_b,
        branch_a,
        branch_b,
        issuer,
        verifier,
        ops_key,
        hr_key,
    }
}

impl World {
    pub async fn token(&self, user: UserId) -> String {
        issue_session_token(
            &self.owner,
            &self.issuer,
            AccessTokenInput {
                subject: user,
                org_id: OrgId::from_uuid(self.org),
                roles: Vec::new(),
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
        .await
    }

    pub fn router(&self) -> axum::Router {
        let service = AccessService::new(self.rt.clone(), Some(passkey_service()));
        router(AccessRestState::new(service, Some(self.verifier.clone())))
    }

    pub async fn call(
        &self,
        method: Method,
        uri: &str,
        user: UserId,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let token = self.token(user).await;
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from(([203, 0, 113, 7], 40000))));
        let response = self.router().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// Create an ACTIVE role as ops; returns its id.
    pub async fn role(&self, name: &str, lines: Value) -> Uuid {
        let (status, body) = self
            .call(
                Method::POST,
                "/api/v1/access/roles",
                self.ops,
                Some(json!({ "name_ko": name, "lines": lines })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        body["id"].as_str().unwrap().parse().unwrap()
    }

    /// Preview `ops` as `actor` (ops by default) and apply with a fresh step-up.
    pub async fn grant_as(&mut self, actor: UserId, operations: Value) -> (StatusCode, Value) {
        let body = json!({ "reason_code": "PROMOTION_OR_REASSIGNMENT", "operations": operations });
        let (status, preview) = self
            .call(
                Method::POST,
                "/api/v1/access/grants/preview",
                actor,
                Some(body),
            )
            .await;
        if status != StatusCode::OK || preview["refused"] != 0 {
            return (status, preview);
        }
        let key = if actor == self.hr {
            &mut self.hr_key
        } else {
            &mut self.ops_key
        };
        let step_up = key.step_up(&self.owner).await;
        let apply = json!({ "receipt_id": preview["receipt_id"], "step_up": step_up });
        let (status, mut body) = self
            .call(
                Method::POST,
                "/api/v1/access/grants/apply",
                actor,
                Some(apply),
            )
            .await;
        if status == StatusCode::OK {
            body = body["items"].take();
        }
        (status, body)
    }

    pub async fn grant(&mut self, operations: Value) -> Value {
        let (status, body) = self.grant_as(self.ops, operations).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }

    pub async fn go_live(&self) {
        sqlx::query(
            "UPDATE tenant_phase SET phase = 'OPERATING', go_live_at = now(), go_live_by = $2, \
             go_live_preview_digest = repeat('a', 64) WHERE org_id = $1",
        )
        .bind(self.org)
        .bind(*self.ops.as_uuid())
        .execute(&self.owner)
        .await
        .unwrap();
    }
}

pub fn grant_op(
    account: UserId,
    role: Uuid,
    kind: &str,
    node: Option<Uuid>,
    in_setup: bool,
) -> Value {
    json!({
        "op": "grant", "account_id": account.as_uuid(), "role_id": role,
        "scope": { "kind": kind, "node_id": node, "include_descendants": true },
        "effective_in_setup": in_setup,
    })
}
