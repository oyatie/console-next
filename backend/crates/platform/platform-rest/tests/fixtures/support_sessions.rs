// SPDX-License-Identifier: LicenseRef-Proprietary
use super::fixture::Harness;
use axum::{
    Extension, Json, Router,
    body::{Body, to_bytes},
    routing::get,
};
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::{
    AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier, MobilePasskeyStepUpBinding,
    MobileStepUpActionKind,
};
use console_platform_authz::{Principal, Role};
use console_platform_provisioning::PlatformProvisioner;
use console_platform_request_context::{support::with_support_gate, with_request_context};
use console_platform_rest::{PlatformRestState, router};
use console_platform_test_support::{
    issue_session_token, runtime_role_pool,
    soft_passkey::{SoftKey, passkey_service},
};
use http::{Request, StatusCode, header};
use p256::{
    ecdsa::SigningKey,
    elliptic_curve::rand_core::OsRng,
    pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use uuid::Uuid;

#[path = "support_proof.rs"]
mod support_proof;
use support_proof::proof;

pub const PLATFORM: &str = "/api/platform/support-sessions";
pub const TENANT: &str = "/api/v1/support-sessions";
pub const READ: &str = "/api/v1/employees";

pub struct Operator {
    pub id: UserId,
    pub key: SoftKey,
    pub token: String,
}

pub struct Support {
    pub owner: PgPool,
    pub rt: PgPool,
    pub app: Router,
    pub org: Uuid,
    pub tenant: String,
    pub a: Operator,
    pub b: Operator,
    pub writes: Arc<AtomicUsize>,
}

impl Support {
    pub async fn new(owner: PgPool) -> Self {
        let base = Harness::new(owner.clone()).await;
        let org = base.onboard("support-http").await;
        let rt = runtime_role_pool(&owner).await;
        let signing = SigningKey::random(&mut OsRng);
        let private = signing.to_pkcs8_pem(LineEnding::LF).unwrap();
        let public = signing
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap();
        let settings = JwtSettings {
            issuer: "support-tests".into(),
            audience: "console-api".into(),
            access_token_ttl: Duration::minutes(15),
        };
        let origin = "https://tenant.example.com";
        let issuer =
            JwtIssuer::from_es256_pem(settings.clone(), private.as_bytes(), public.as_bytes())
                .unwrap();
        let support_issuer = JwtIssuer::from_es256_pem(
            JwtSettings {
                audience: origin.into(),
                ..settings.clone()
            },
            private.as_bytes(),
            public.as_bytes(),
        )
        .unwrap();
        let verifier = JwtVerifier::from_es256_public_pem(settings, public.as_bytes())
            .unwrap()
            .with_support_audience(origin.into());
        let a = operator(&owner, &rt, &issuer).await;
        let b = operator(&owner, &rt, &issuer).await;
        let user: Uuid =
            sqlx::query_scalar("SELECT id FROM users WHERE org_id=$1 AND is_tenant_ops")
                .bind(org)
                .fetch_one(&owner)
                .await
                .unwrap();
        let tenant = token(
            &rt,
            &issuer,
            UserId::from_uuid(user),
            OrgId::from_uuid(org),
            false,
            vec![],
        )
        .await;
        let service = router(
            PlatformRestState::new(
                rt.clone(),
                Some(verifier.clone()),
                PlatformProvisioner::new(Duration::minutes(15)),
            )
            .with_support_issuer(Some(support_issuer))
            .with_passkey_step_up(Some(passkey_service())),
        );
        let writes = Arc::new(AtomicUsize::new(0));
        let count = writes.clone();
        let probe = Router::new().route(READ,get(|Extension(_):Extension<Principal>|async {
            Json(json!({"display_name":"고객 이름","phone":"010-private","personal_email":"private@example.com"}))
        }).post(move || {let count=count.clone();async move {count.fetch_add(1,Ordering::SeqCst);Json(json!({"mutated":true}))}}));
        let app = with_support_gate(
            service.merge(with_request_context(
                probe,
                Some(verifier.clone()),
                rt.clone(),
            )),
            Some(verifier),
            rt.clone(),
        );
        Self {
            owner,
            rt,
            app,
            org,
            tenant,
            a,
            b,
            writes,
        }
    }

    pub fn body(&self, id: Uuid) -> Value {
        json!({"id":id,"org_id":self.org,"ticket_ref":"TICKET-123","reason_code":"TROUBLESHOOT",
            "reason":"조회 오류 조사","scope":["hr_basic"],"duration_seconds":60})
    }

    pub async fn send(
        &self,
        method: &str,
        path: &str,
        body: Value,
        token: &str,
    ) -> (StatusCode, Value) {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let response = self.app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        if status.is_client_error() && path.contains("support-sessions") {
            assert_eq!(
                response.headers()[header::CONTENT_TYPE],
                "application/problem+json"
            );
        }
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    pub async fn signed(
        &mut self,
        second: bool,
        id: Uuid,
        action: &str,
        mut body: Value,
    ) -> (StatusCode, Value) {
        body["step_up"] = self.proof_for(second, id, action, &body).await;
        let token = if second {
            self.b.token.clone()
        } else {
            self.a.token.clone()
        };
        let path = if action == "request" {
            PLATFORM.to_owned()
        } else {
            format!("{PLATFORM}/{id}/{action}")
        };
        self.send("POST", &path, body, &token).await
    }

    pub async fn proof_for(&mut self, second: bool, id: Uuid, action: &str, body: &Value) -> Value {
        let payload = if action == "request" {
            json!([
                self.org,
                id,
                action,
                body["ticket_ref"],
                body["reason_code"],
                body["reason"],
                body["scope"],
                body["duration_seconds"]
            ])
        } else {
            json!([self.org, id, action])
        };
        let actor = if second { &mut self.b } else { &mut self.a };
        proof(&self.owner, actor.id, &mut actor.key, id, payload).await
    }

    pub async fn request(&mut self, id: Uuid) -> (StatusCode, Value) {
        self.signed(false, id, "request", self.body(id)).await
    }

    pub async fn approve(&mut self, id: Uuid) -> (StatusCode, Value) {
        self.signed(true, id, "approve", json!({"org_id":self.org}))
            .await
    }

    pub async fn decide(&self, id: Uuid, decision: &str) -> (StatusCode, Value) {
        self.send(
            "POST",
            &format!("{TENANT}/{id}/decision"),
            json!({"decision":decision,"approved_duration_seconds":60,"reveal_classes":[]}),
            &self.tenant,
        )
        .await
    }

    pub async fn start(&mut self, id: Uuid) -> (StatusCode, Value) {
        self.signed(false, id, "start", json!({"org_id":self.org}))
            .await
    }

    pub async fn active(&mut self) -> (Uuid, String) {
        let id = Uuid::new_v4();
        ok(self.request(id).await, StatusCode::CREATED);
        ok(self.approve(id).await, StatusCode::OK);
        ok(self.decide(id, "APPROVE").await, StatusCode::OK);
        let result = self.start(id).await;
        assert_eq!(result.0, StatusCode::OK, "{}", result.1);
        (id, result.1["access_token"].as_str().unwrap().to_owned())
    }

    pub async fn accesses(&self, id: Uuid) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id=$1 AND target_id=$2 AND action='support.access'")
            .bind(self.org).bind(id.to_string()).fetch_one(&self.owner).await.unwrap()
    }
}

async fn operator(owner: &PgPool, rt: &PgPool, issuer: &JwtIssuer) -> Operator {
    let id = UserId::new();
    let roles = vec![Role::SuperAdmin.as_str().to_owned()];
    sqlx::query(
        "INSERT INTO users(id,org_id,display_name,roles) VALUES($1,$2,'Support operator',$3)",
    )
    .bind(id.as_uuid())
    .bind(OrgId::platform().as_uuid())
    .bind(&roles)
    .execute(owner)
    .await
    .unwrap();
    let key = SoftKey::enroll(owner, OrgId::platform(), id).await;
    let token = token(rt, issuer, id, OrgId::platform(), true, roles).await;
    Operator { id, key, token }
}

async fn token(
    pool: &PgPool,
    issuer: &JwtIssuer,
    user: UserId,
    org: OrgId,
    platform: bool,
    roles: Vec<String>,
) -> String {
    issue_session_token(
        pool,
        issuer,
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

pub fn ok(result: (StatusCode, Value), status: StatusCode) {
    assert_eq!(result.0, status, "{}", result.1);
}
pub fn code(result: (StatusCode, Value), status: StatusCode, expected: &str) {
    assert_eq!(result.0, status, "{}", result.1);
    assert_eq!(result.1["code"], expected, "{}", result.1);
    assert_eq!(result.1["status"], status.as_u16());
    assert_eq!(result.1["error"]["code"], expected);
}
