// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::expect_used, clippy::panic, clippy::unwrap_used)]

use axum::body::{Body, to_bytes};
use console_kernel_core::{OrgId, UserId};
use console_payroll_adapter_postgres::PgPayrollStore;
use console_payroll_rest::{PayrollRestState, router};
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use http::{Request, StatusCode, header};
use serde_json::Value;
use sqlx::{PgPool, postgres::PgPoolOptions};
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;

pub(crate) const ISSUER: &str = "console-platform-auth";
pub(crate) const AUDIENCE: &str = "console-api";
pub(crate) const SHA256_FIXTURE: &str =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

pub(crate) async fn runtime_role_pool(owner: &PgPool) -> PgPool {
    PgPoolOptions::new()
        .max_connections(4)
        .after_connect(|conn, _| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_rt").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(owner.connect_options().as_ref().clone())
        .await
        .unwrap()
}

pub(crate) async fn token_for(
    pool: &PgPool,
    priv_pem: &str,
    pub_pem: &str,
    user: UserId,
    org: OrgId,
    role: &str,
) -> String {
    console_platform_test_support::issue_session_token(
        pool,
        &JwtIssuer::from_es256_pem(
            JwtSettings {
                issuer: ISSUER.into(),
                audience: AUDIENCE.into(),
                access_token_ttl: Duration::minutes(15),
            },
            priv_pem.as_bytes(),
            pub_pem.as_bytes(),
        )
        .unwrap(),
        AccessTokenInput {
            subject: user,
            org_id: org,
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
        None,
        Vec::new(),
    )
    .await
}

pub(crate) async fn send(
    rt: &PgPool,
    pub_pem: &str,
    method: &str,
    uri: &str,
    token: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let verifier = JwtVerifier::from_es256_public_pem(
        JwtSettings {
            issuer: ISSUER.into(),
            audience: AUDIENCE.into(),
            access_token_ttl: Duration::minutes(15),
        },
        pub_pem.as_bytes(),
    )
    .unwrap();
    let app = router(PayrollRestState::new(
        PgPayrollStore::new(rt.clone()),
        Some(verifier),
    ));
    let req = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(
            body.map(|v| Body::from(serde_json::to_vec(&v).unwrap()))
                .unwrap_or_else(Body::empty),
        )
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    let st = res.status();
    let bytes = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    (st, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}
