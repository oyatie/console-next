// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Exercise the real authenticated router as console_rt; refused batches leave no decisions.
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use console_kernel_core::OrgId;
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use console_platform_authz_rest::{
    CedarPolicyRestState, POLICY_AUTHORIZE_BULK_PATH, POLICY_DECISIONS_PATH, PgCedarPolicyStore,
    router,
};
use console_platform_test_support::{
    issue_session_token, runtime_role_pool, seed_org_and_super_admin,
};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use uuid::Uuid;

async fn app(pool: &PgPool) -> (axum::Router, String, Uuid) {
    let org = Uuid::new_v4();
    let user = seed_org_and_super_admin(pool, org, "bulk-limits").await;
    let key = SigningKey::random(&mut OsRng);
    let settings = JwtSettings {
        issuer: "bulk-limit-test".to_owned(),
        audience: "bulk-limit-test".to_owned(),
        access_token_ttl: Duration::minutes(15),
    };
    let issuer = JwtIssuer::from_es256_pem(
        settings.clone(),
        key.to_pkcs8_pem(LineEnding::LF).unwrap().as_bytes(),
        key.verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    let verifier = JwtVerifier::from_es256_public_pem(
        settings,
        key.verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    let token = issue_session_token(
        pool,
        &issuer,
        AccessTokenInput {
            subject: user,
            org_id: OrgId::from_uuid(org),
            roles: vec!["SUPER_ADMIN".to_owned()],
            branches: vec![],
            platform: false,
            view_as: false,
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
    .await;
    let store = PgCedarPolicyStore::new(runtime_role_pool(pool).await);
    (
        router(CedarPolicyRestState::new(store, Some(verifier))),
        token,
        org,
    )
}

fn batch(org: Uuid, count: usize) -> Value {
    json!({
        "subject": { "org": org, "user_id": "synthetic-subject", "roles": [], "clearance_keys": [] },
        "checks": vec![json!({ "action": "view", "resource": { "org": org, "resource_type": "work_order" } }); count],
    })
}

async fn send(app: &axum::Router, token: &str, body: Option<Value>) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(if body.is_some() { "POST" } else { "GET" })
        .uri(if body.is_some() {
            POLICY_AUTHORIZE_BULK_PATH
        } else {
            POLICY_DECISIONS_PATH
        })
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(body.map_or_else(Body::empty, |v| Body::from(v.to_string())))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn excess_checks_are_refused_without_persisting_decisions(pool: PgPool) {
    let (app, token, org) = app(&pool).await;
    let (status, body) = send(&app, &token, Some(batch(org, 201))).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["error"]["code"], "policy_bulk_limit");
    assert_eq!(send(&app, &token, None).await, (StatusCode::OK, json!([])));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn repeated_subject_work_is_refused_below_the_http_body_limit(pool: PgPool) {
    let (app, token, org) = app(&pool).await;
    for field in ["user_id", "roles", "clearance_keys"] {
        let mut request = batch(org, 17);
        let large = "x".repeat(128 * 1024);
        request["subject"][field] = if field == "user_id" {
            json!(large)
        } else {
            json!([large])
        };
        assert!(request.to_string().len() < 2 * 1024 * 1024);
        let (status, body) = send(&app, &token, Some(request)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{field}");
        assert_eq!(body["error"]["code"], "policy_bulk_limit");
    }
    assert_eq!(send(&app, &token, None).await, (StatusCode::OK, json!([])));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn empty_and_at_limit_batches_keep_every_decision(pool: PgPool) {
    let (app, token, org) = app(&pool).await;
    for count in [0, 1, 200] {
        let (status, body) = send(&app, &token, Some(batch(org, count))).await;
        assert_eq!(status, StatusCode::OK);
        let decisions = body["decisions"].as_array().unwrap();
        assert_eq!(decisions.len(), count);
        assert!(decisions.iter().all(|d| d["effect"] == "deny"));
    }
    let (status, feed) = send(&app, &token, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(feed.as_array().unwrap().len(), 200);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn exactly_two_mib_of_subject_work_is_allowed_and_excess_is_atomic(pool: PgPool) {
    let (app, token, org) = app(&pool).await;
    let mut request = batch(org, 2);
    request["subject"]["clearance_keys"] = json!([""]);
    let overhead = request["subject"].to_string().len();
    request["subject"]["clearance_keys"] = json!(["x".repeat(1024 * 1024 - overhead)]);
    assert_eq!(request["subject"].to_string().len() * 2, 2 * 1024 * 1024);
    let (status, body) = send(&app, &token, Some(request.clone())).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["decisions"].as_array().unwrap().len(), 2);

    request["subject"]["clearance_keys"] = json!(["x".repeat(1024 * 1024 - overhead + 1)]);
    let (status, body) = send(&app, &token, Some(request)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["error"]["code"], "policy_bulk_limit");
    let (status, feed) = send(&app, &token, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(feed.as_array().unwrap().len(), 2);
}
