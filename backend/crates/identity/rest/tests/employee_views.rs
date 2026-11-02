// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use console_identity_adapter_postgres::PgOrgStore;
use console_identity_rest::{IdentityRestState, router};
use console_kernel_core::{OrgId, UserId};
use console_onboarding_adapter_postgres::PgOnboardingStore;
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use console_platform_test_support::{
    issue_session_token, runtime_role_pool, seed_active_user, seed_org_and_super_admin,
};
use p256::{
    ecdsa::SigningKey,
    elliptic_curve::rand_core::OsRng,
    pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding},
};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use uuid::Uuid;

const PATH: &str = "/api/v1/me/employee-views";
struct Harness {
    app: Router,
    runtime: PgPool,
    issuer: JwtIssuer,
}
impl Harness {
    async fn new(pool: &PgPool) -> Self {
        let key = SigningKey::random(&mut OsRng);
        let private = key.to_pkcs8_pem(LineEnding::LF).unwrap();
        let public = key
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap();
        let settings = JwtSettings {
            issuer: "console-platform-auth".into(),
            audience: "console-api".into(),
            access_token_ttl: Duration::minutes(15),
        };
        let issuer =
            JwtIssuer::from_es256_pem(settings.clone(), private.as_bytes(), public.as_bytes())
                .unwrap();
        let verifier = JwtVerifier::from_es256_public_pem(settings, public.as_bytes()).unwrap();
        let runtime = runtime_role_pool(pool).await;
        let app = router(IdentityRestState::new(
            PgOrgStore::new(runtime.clone()),
            Some(verifier),
            PgOnboardingStore::new(runtime.clone()),
        ));
        Self {
            app,
            runtime,
            issuer,
        }
    }
    async fn token(&self, org: OrgId, user: UserId) -> String {
        issue_session_token(
            &self.runtime,
            &self.issuer,
            AccessTokenInput {
                subject: user,
                org_id: org,
                roles: vec!["MEMBER".into()],
                branches: vec![],
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
    async fn call(
        &self,
        token: &str,
        body: Option<Value>,
        key: Option<&str>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .uri(PATH)
            .header("Authorization", format!("Bearer {token}"));
        if let Some(key) = key {
            request = request.header("Idempotency-Key", key);
        }
        let request = if let Some(body) = body {
            request
                .method("POST")
                .header("Content-Type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap()
        } else {
            request.body(Body::empty()).unwrap()
        };
        let response = self.app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
}
fn view(name: &str) -> Value {
    json!({"id": Uuid::new_v4(), "name": name, "filters": {"status":"ACTIVE", "review":"identity,failed", "unit":format!("le:{}", Uuid::new_v4()), "sort":"name"}})
}
async fn account(pool: &PgPool, h: &Harness) -> String {
    let user = seed_active_user(pool, *OrgId::one().as_uuid(), "MEMBER", "Saved views").await;
    h.token(OrgId::one(), user).await
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn saved_views_persist_replay_and_audit_once(pool: PgPool) {
    let h = Harness::new(&pool).await;
    let token = account(&pool, &h).await;
    assert_eq!(
        h.call(&token, None, None).await,
        (StatusCode::OK, json!({"items":[]}))
    );
    let body = view("재직 직원");
    let key = body["id"].as_str().unwrap();
    assert_eq!(
        h.call(&token, Some(body.clone()), Some(key)).await,
        (StatusCode::CREATED, body.clone())
    );
    assert_eq!(
        h.call(&token, Some(body.clone()), Some(key)).await,
        (StatusCode::OK, body.clone())
    );
    assert_eq!(
        h.call(&token, None, None).await,
        (StatusCode::OK, json!({"items":[body]}))
    );
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE action = 'employee_view.create'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn saved_views_are_private_to_actor_and_tenant_even_on_replay(pool: PgPool) {
    let h = Harness::new(&pool).await;
    let first = account(&pool, &h).await;
    let second = account(&pool, &h).await;
    let org = OrgId::new();
    seed_org_and_super_admin(&pool, *org.as_uuid(), "Private views").await;
    let foreign = seed_active_user(&pool, *org.as_uuid(), "MEMBER", "Foreign views").await;
    let foreign = h.token(org, foreign).await;
    let body = view("내 명부");
    let key = body["id"].as_str().unwrap();
    for (index, token) in [&first, &second, &foreign].into_iter().enumerate() {
        let mut body = body.clone();
        body["name"] = json!(format!("내 명부 {index}"));
        assert_eq!(
            h.call(token, None, None).await,
            (StatusCode::OK, json!({"items":[]}))
        );
        assert_eq!(
            h.call(token, Some(body.clone()), Some(key)).await,
            (StatusCode::CREATED, body.clone())
        );
        assert_eq!(h.call(token, None, None).await.1, json!({"items":[body]}));
        assert_eq!(
            h.call(token, Some(body.clone()), Some(key)).await,
            (StatusCode::OK, body)
        );
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn saved_views_refuse_duplicate_name_and_changed_idempotent_payload(pool: PgPool) {
    let h = Harness::new(&pool).await;
    let token = account(&pool, &h).await;
    let body = view("재직 직원");
    let key = body["id"].as_str().unwrap();
    assert_eq!(
        h.call(&token, Some(body.clone()), Some(key)).await.0,
        StatusCode::CREATED
    );
    let duplicate = view(" 재직 직원 ");
    let (status, error) = h
        .call(&token, Some(duplicate.clone()), duplicate["id"].as_str())
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert_eq!(error["error"]["code"], "employee_view_name_taken");
    let mut changed = body.clone();
    changed["name"] = json!("다른 이름");
    let (status, error) = h.call(&token, Some(changed), Some(key)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert_eq!(error["error"]["code"], "idempotency_key_reused");
    assert_eq!(h.call(&token, None, None).await.1, json!({"items":[body]}));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn saved_views_refuse_bad_key_names_and_filters_without_writing(pool: PgPool) {
    let h = Harness::new(&pool).await;
    let token = account(&pool, &h).await;
    let body = view("명부");
    for key in [None, Some("different-view-id")] {
        let (status, error) = h.call(&token, Some(body.clone()), key).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{error}");
        assert_eq!(error["error"]["code"], "employee_view_key_mismatch");
    }
    for (field, value) in [
        ("name", json!("  ")),
        ("name", json!("x".repeat(201))),
        ("filters", json!({"sort":"x".repeat(201)})),
        ("filters", json!({"unknown":"value"})),
        ("filters", json!({"sort":true})),
        ("filters", json!({"status":" "})),
        ("user_id", json!(Uuid::new_v4())),
        ("id", json!("invalid")),
    ] {
        let mut invalid = body.clone();
        invalid["id"] = json!(Uuid::new_v4());
        invalid[field] = value;
        let key = invalid["id"].as_str().unwrap().to_owned();
        assert_eq!(
            h.call(&token, Some(invalid), Some(&key)).await.0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    assert_eq!(h.call(&token, None, None).await.1, json!({"items":[]}));
    assert_eq!(h.call("", None, None).await.0, StatusCode::UNAUTHORIZED);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn saved_views_concurrent_retries_and_duplicate_names_are_atomic(pool: PgPool) {
    let h = Harness::new(&pool).await;
    let token = account(&pool, &h).await;
    let body = view("동시 저장");
    let key = body["id"].as_str().unwrap();
    let (a, b) = tokio::join!(
        h.call(&token, Some(body.clone()), Some(key)),
        h.call(&token, Some(body.clone()), Some(key))
    );
    let mut statuses = [a.0.as_u16(), b.0.as_u16()];
    statuses.sort();
    assert!(
        statuses == [200, 201] || statuses == [201, 409],
        "{statuses:?}"
    );
    assert_eq!(
        h.call(&token, Some(body.clone()), Some(key)).await,
        (StatusCode::OK, body.clone())
    );
    let a = view("중복 저장");
    let b = view("중복 저장");
    let (a, b) = tokio::join!(
        h.call(&token, Some(a.clone()), a["id"].as_str()),
        h.call(&token, Some(b.clone()), b["id"].as_str())
    );
    let mut statuses = [a.0.as_u16(), b.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [201, 409]);
    let refused = if a.0 == StatusCode::CONFLICT {
        a.1
    } else {
        b.1
    };
    assert_eq!(refused["error"]["code"], "employee_view_name_taken");
    assert_eq!(
        h.call(&token, None, None).await.1["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[path = "employee_views/store.rs"]
mod store;
