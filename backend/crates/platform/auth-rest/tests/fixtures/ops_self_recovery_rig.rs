// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use console_kernel_core::{OrgId, UserId};
use console_platform_auth_rest::{
    AuthRestConfig, AuthRestState, PASSKEY_LOGIN_FINISH_PATH, PASSKEY_LOGIN_START_PATH,
    PRIVACY_CONSENT_ACCEPT_PATH, PRIVACY_CONSENT_STATUS_PATH, router,
};
use console_platform_email::{BoxFuture, EmailError, EmailSender, RenderedEmail};
use console_platform_provisioning::PlatformProvisioner;
use console_platform_provisioning::ops_self_recovery::RecoveryContactCipher;
use console_platform_test_support::runtime_role_pool;
use console_platform_test_support::soft_passkey::SoftKey;
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::Generate;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use uuid::Uuid;

#[derive(Clone, Default)]
pub struct CapturingMailer(pub Arc<Mutex<Vec<(String, String)>>>, pub Arc<AtomicBool>);

impl EmailSender for CapturingMailer {
    fn send_otp<'a>(
        &'a self,
        to: &'a str,
        code: &'a str,
        _ttl: std::time::Duration,
    ) -> BoxFuture<'a, Result<(), EmailError>> {
        if self.1.load(Ordering::Relaxed) {
            return Box::pin(async {
                Err(EmailError::Config("synthetic transport refusal".to_owned()))
            });
        }
        self.0
            .lock()
            .unwrap()
            .push((to.to_owned(), code.to_owned()));
        Box::pin(async { Ok(()) })
    }

    fn send_rendered<'a>(&'a self, _: &'a RenderedEmail) -> BoxFuture<'a, Result<(), EmailError>> {
        Box::pin(async { Ok(()) })
    }
}

pub struct Rig {
    pub owner: PgPool,
    pub rt: PgPool,
    pub app: axum::Router,
    pub mailer: CapturingMailer,
    pub cipher: RecoveryContactCipher,
    pub org: OrgId,
    pub slug: String,
    pub ops: UserId,
    pub ops_identifier: String,
    pub ops_otp: String,
}

impl Rig {
    pub async fn new(owner: PgPool) -> Self {
        console_platform_test_support::seed_consent_documents(&owner).await;
        let rt = runtime_role_pool(&owner).await;
        let mailer = CapturingMailer::default();
        let cipher = RecoveryContactCipher::dev_ephemeral().unwrap();
        let key = SigningKey::generate();
        let state = AuthRestState::new(
            rt.clone(),
            AuthRestConfig {
                rp_id: "example.com".to_owned(),
                rp_origin: "https://auth.example.com".to_owned(),
                rp_name: "Console".to_owned(),
                ceremony_ttl: Duration::minutes(5),
                jwt_issuer: "console-platform-auth".to_owned(),
                jwt_audience: "console-api".to_owned(),
                access_token_ttl: Duration::minutes(15),
                jwt_private_key_pem: key.to_pkcs8_pem(LineEnding::LF).unwrap().to_string(),
                jwt_public_key_pem: key
                    .verifying_key()
                    .to_public_key_pem(LineEnding::LF)
                    .unwrap(),
                refresh_token_ttl: Duration::days(30),
                refresh_family_absolute_ttl: Duration::hours(24),
                cookie_secure: false,
            },
        )
        .unwrap()
        .with_recovery_cipher(cipher.clone())
        .with_email_sender(Arc::new(mailer.clone()));
        let slug = format!("rec-{}", &Uuid::new_v4().simple().to_string()[..10]);
        let created = PlatformProvisioner::new(Duration::hours(1))
            .onboard_tenant(
                &rt,
                None,
                &slug,
                "Recovery Tenant",
                OffsetDateTime::now_utc(),
            )
            .await
            .unwrap();
        let org = OrgId::from_uuid(created.organization.id);
        let ops = UserId::from_uuid(created.admin_user_id);
        let ops_identifier: String = sqlx::query_scalar(
            "SELECT s.login || '@' || o.slug FROM user_sign_in_ids s JOIN organizations o ON o.id = s.org_id WHERE s.user_id = $1 AND s.retired_at IS NULL",
        )
        .bind(ops.as_uuid())
        .fetch_one(&owner)
        .await
        .unwrap();
        Self {
            owner,
            rt,
            app: router(state),
            mailer,
            cipher,
            org,
            slug,
            ops,
            ops_identifier,
            ops_otp: created.admin_otp.as_str().to_owned(),
        }
    }

    pub async fn call(
        &self,
        method: Method,
        uri: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut b = Request::builder().method(method).uri(uri);
        if let Some(t) = token {
            b = b.header(header::AUTHORIZATION, format!("Bearer {t}"));
        }
        let req = match body {
            Some(v) => b
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(v.to_string()))
                .unwrap(),
            None => b.body(Body::empty()).unwrap(),
        };
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    pub async fn login_passkey(&self, key: &mut SoftKey) -> (StatusCode, Value) {
        let (st, start) = self
            .call(
                Method::POST,
                PASSKEY_LOGIN_START_PATH,
                None,
                Some(json!({ "identifier": self.ops_identifier })),
            )
            .await;
        assert_eq!(st, StatusCode::OK, "{start}");
        let Ok(assertion) = key.assert(&start["challenge"]) else {
            return (StatusCode::UNAUTHORIZED, json!({}));
        };
        let (st_fin, fin) = self
            .call(
                Method::POST,
                PASSKEY_LOGIN_FINISH_PATH,
                None,
                Some(json!({ "ceremony_id": start["ceremony_id"], "credential": assertion })),
            )
            .await;
        if st_fin == StatusCode::OK
            && let Some(jwt) = fin["access_token"].as_str()
        {
            let (_, doc) = self
                .call(
                    Method::POST,
                    PRIVACY_CONSENT_STATUS_PATH,
                    Some(jwt),
                    Some(json!({})),
                )
                .await;
            let _ = self
                .call(
                    Method::POST,
                    PRIVACY_CONSENT_ACCEPT_PATH,
                    Some(jwt),
                    Some(json!({
                        "privacy": doc["privacy"],
                        "terms": doc["terms"],
                        "privacy_collection": true,
                        "terms_of_service": true
                    })),
                )
                .await;
        }
        (st_fin, fin)
    }
}
