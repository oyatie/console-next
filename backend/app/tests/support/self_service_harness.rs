// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::body::{Body, to_bytes};
use console_kernel_core::{BranchId, OrgId, UserId};
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings};
use http::{HeaderMap, Request, StatusCode, header};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::Generate;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::Value;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;

pub(crate) async fn role_pool(owner: &PgPool, role: &'static str) -> PgPool {
    let opts = owner.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(4)
        .after_connect(move |c, _| {
            let stmt = format!("SET ROLE {role}");
            Box::pin(async move {
                sqlx::query(sqlx::AssertSqlSafe(stmt))
                    .execute(c)
                    .await
                    .map(|_| ())
            })
        })
        .connect_with(opts)
        .await
        .unwrap()
}

pub(crate) fn gen_keys() -> (String, String) {
    let sk = SigningKey::generate();
    (
        sk.to_pkcs8_pem(LineEnding::LF).unwrap().to_string(),
        sk.verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap(),
    )
}

pub(crate) async fn token_for(
    pool: &PgPool,
    priv_pem: &str,
    pub_pem: &str,
    org: OrgId,
    uid: UserId,
    roles: Vec<String>,
    branches: Vec<BranchId>,
) -> String {
    let issuer = JwtIssuer::from_es256_pem(
        JwtSettings {
            issuer: "console-platform-auth".into(),
            audience: "console-api".into(),
            access_token_ttl: Duration::minutes(15),
        },
        priv_pem.as_bytes(),
        pub_pem.as_bytes(),
    )
    .unwrap();
    console_platform_test_support::issue_session_token(
        pool,
        &issuer,
        AccessTokenInput {
            subject: uid,
            org_id: org,
            roles,
            branches,
            platform: false,
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

pub(crate) async fn call_json(
    app: axum::Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Option<Value>,
    extra: &[(&str, &str)],
) -> (StatusCode, HeaderMap, Value) {
    let mut b = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(t) = token {
        b = b.header(header::AUTHORIZATION, format!("Bearer {t}"));
    }
    for (k, v) in extra {
        b = b.header(*k, *v);
    }
    let req = b
        .body(Body::from(body.map_or(String::new(), |v| v.to_string())))
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    let status = resp.status();
    let headers = resp.headers().clone();
    let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, headers, json)
}
