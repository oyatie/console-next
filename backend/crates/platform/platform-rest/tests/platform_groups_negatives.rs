// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::Router;
use axum::body::{Body, to_bytes};
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use console_platform_provisioning::PlatformProvisioner;
use console_platform_rest::{PLATFORM_GROUPS_PATH, PlatformRestState, router};
use console_platform_test_support::soft_passkey::{self, SoftKey};
use http::{Method, Request, StatusCode, header};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::Generate;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use uuid::Uuid;

struct Harness {
    private_pem: String,
    public_pem: String,
    rt_pool: PgPool,
}

impl Harness {
    async fn new(owner: &PgPool) -> Self {
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

    fn service(&self) -> Router {
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

    async fn token(
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

async fn call(
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

async fn seed_user(pool: &PgPool, org: OrgId, roles: Vec<String>) -> UserId {
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

async fn seed_org(pool: &PgPool, slug: &str, status: &str) -> Uuid {
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

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn group_routes_enforce_negatives_and_account_dto_fields(pool: PgPool) {
    let h = Harness::new(&pool).await;
    let service = h.service();
    let admin = seed_user(&pool, OrgId::platform(), vec!["SUPER_ADMIN".into()]).await;
    let admin_token = h
        .token(admin, OrgId::platform(), true, vec!["SUPER_ADMIN".into()])
        .await;
    let mut key = SoftKey::enroll(&pool, OrgId::platform(), admin).await;

    let unprivileged = seed_user(&pool, OrgId::platform(), vec!["MEMBER".into()]).await;
    let unprivileged_token = h
        .token(unprivileged, OrgId::platform(), true, vec!["MEMBER".into()])
        .await;

    let tenant_active = seed_org(&pool, "active", "ACTIVE").await;
    let tenant_user = seed_user(
        &pool,
        OrgId::from_uuid(tenant_active),
        vec!["SUPER_ADMIN".into()],
    )
    .await;
    let tenant_token = h
        .token(
            tenant_user,
            OrgId::from_uuid(tenant_active),
            false,
            vec!["SUPER_ADMIN".into()],
        )
        .await;

    // Seed groups to exercise cross-group revoke, DTO fields, and SUSPENDED/ARCHIVED refusal.
    let (_, g1) = call(
        &service,
        Method::POST,
        PLATFORM_GROUPS_PATH.into(),
        &admin_token,
        Some(json!({"slug":"g-neg-1","name":"Group One"})),
    )
    .await;
    let (_, g2) = call(
        &service,
        Method::POST,
        PLATFORM_GROUPS_PATH.into(),
        &admin_token,
        Some(json!({"slug":"g-neg-2","name":"Group Two"})),
    )
    .await;
    let (_, g_susp) = call(
        &service,
        Method::POST,
        PLATFORM_GROUPS_PATH.into(),
        &admin_token,
        Some(json!({"slug":"g-susp","name":"Suspended"})),
    )
    .await;
    let (_, g_arch) = call(
        &service,
        Method::POST,
        PLATFORM_GROUPS_PATH.into(),
        &admin_token,
        Some(json!({"slug":"g-arch","name":"Archived"})),
    )
    .await;
    let g1_id = Uuid::parse_str(g1["id"].as_str().unwrap()).unwrap();
    let g2_id = Uuid::parse_str(g2["id"].as_str().unwrap()).unwrap();
    let g_susp_id = Uuid::parse_str(g_susp["id"].as_str().unwrap()).unwrap();
    let g_arch_id = Uuid::parse_str(g_arch["id"].as_str().unwrap()).unwrap();
    assert_eq!(
        call(
            &service,
            Method::PATCH,
            format!("/api/platform/groups/{g_susp_id}"),
            &admin_token,
            Some(json!({"status":"SUSPENDED"}))
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &service,
            Method::PATCH,
            format!("/api/platform/groups/{g_arch_id}"),
            &admin_token,
            Some(json!({"status":"ARCHIVED"}))
        )
        .await
        .0,
        StatusCode::OK
    );

    // Missing passkey on operator without enrolled passkey -> 403 passkey_required.
    let no_passkey_admin = seed_user(&pool, OrgId::platform(), vec!["SUPER_ADMIN".into()]).await;
    let no_passkey_token = h
        .token(
            no_passkey_admin,
            OrgId::platform(),
            true,
            vec!["SUPER_ADMIN".into()],
        )
        .await;
    let (st, body) = call(
        &service,
        Method::PUT,
        format!("/api/platform/groups/{g1_id}/organizations/{tenant_active}"),
        &no_passkey_token,
        Some(json!({})),
    )
    .await;
    assert_eq!(
        (st, body["error"]["code"].as_str()),
        (StatusCode::FORBIDDEN, Some("passkey_required"))
    );

    // Duplicate slug -> 409.
    let (st, _) = call(
        &service,
        Method::POST,
        PLATFORM_GROUPS_PATH.into(),
        &admin_token,
        Some(json!({"slug":"g-neg-1","name":"Dup"})),
    )
    .await;
    assert_eq!(st, StatusCode::CONFLICT);

    // Tenant token -> 403 and unprivileged platform role -> 401 on every group endpoint (including GET /api/platform/groups).
    for (token, expected) in [
        (&tenant_token, StatusCode::FORBIDDEN),
        (&unprivileged_token, StatusCode::UNAUTHORIZED),
    ] {
        for (method, path, payload) in [
            (Method::GET, PLATFORM_GROUPS_PATH.to_owned(), None),
            (
                Method::POST,
                PLATFORM_GROUPS_PATH.to_owned(),
                Some(json!({"slug":"g-deny","name":"Deny"})),
            ),
            (
                Method::GET,
                format!("/api/platform/groups/{g1_id}/accounts"),
                None,
            ),
            (
                Method::PUT,
                format!("/api/platform/groups/{g1_id}/organizations/{tenant_active}"),
                Some(json!({})),
            ),
            (
                Method::POST,
                format!("/api/platform/groups/{g1_id}/accounts"),
                Some(
                    json!({"org_id":tenant_active,"display_name":"X","tenant_roles":["MEMBER"],"group_role":"GROUP_ADMIN"}),
                ),
            ),
            (
                Method::DELETE,
                format!("/api/platform/groups/{g1_id}/accounts/{tenant_user}/roles/GROUP_ADMIN"),
                None,
            ),
        ] {
            let (st, _) = call(&service, method, path, token, payload).await;
            assert_eq!(st, expected);
        }
    }

    // SUSPENDED / ARCHIVED groups reject assign and account creation with 422.
    for blocked_group in [g_susp_id, g_arch_id] {
        let (st, _) = call(
            &service,
            Method::PUT,
            format!("/api/platform/groups/{blocked_group}/organizations/{tenant_active}"),
            &admin_token,
            Some(json!({"step_up": key.step_up(&pool).await})),
        )
        .await;
        assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY);
        let (st, _) = call(&service, Method::POST, format!("/api/platform/groups/{blocked_group}/accounts"), &admin_token, Some(json!({"org_id":tenant_active,"display_name":"Blocked","tenant_roles":["MEMBER"],"group_role":"GROUP_ADMIN","step_up": key.step_up(&pool).await}))).await;
        assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY);
    }

    // Unknown and platform sentinel IDs -> 404.
    let missing_id = Uuid::new_v4();
    let (st, _) = call(
        &service,
        Method::GET,
        format!("/api/platform/groups/{missing_id}/accounts"),
        &admin_token,
        None,
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    let (st, _) = call(
        &service,
        Method::PUT,
        format!(
            "/api/platform/groups/{g1_id}/organizations/{}",
            OrgId::platform().as_uuid()
        ),
        &admin_token,
        Some(json!({"step_up": key.step_up(&pool).await})),
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);

    // Assign tenant_active to g1, create group account, assert DTO exposes person_id and principal_kind, and verify cross-group revoke -> 404.
    let (st, _) = call(
        &service,
        Method::PUT,
        format!("/api/platform/groups/{g1_id}/organizations/{tenant_active}"),
        &admin_token,
        Some(json!({"step_up": key.step_up(&pool).await})),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let (st, acct) = call(&service, Method::POST, format!("/api/platform/groups/{g1_id}/accounts"), &admin_token, Some(json!({"org_id":tenant_active,"display_name":"GroupOp","phone":"groupop@example.com","tenant_roles":["MEMBER"],"group_role":"GROUP_ADMIN","step_up": key.step_up(&pool).await}))).await;
    assert_eq!(st, StatusCode::CREATED, "{acct}");
    let uid = acct["account"]["user_id"].as_str().unwrap().to_owned();

    let (st, listed) = call(
        &service,
        Method::GET,
        format!("/api/platform/groups/{g1_id}/accounts"),
        &admin_token,
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{listed}");
    let item = &listed.as_array().unwrap()[0];
    assert!(
        item.get("person_id").is_some(),
        "person_id must be serialized: {item}"
    );
    assert_eq!(item["principal_kind"], "TENANT_PERSON");

    let (st, _) = call(
        &service,
        Method::DELETE,
        format!("/api/platform/groups/{g2_id}/accounts/{uid}/roles/GROUP_ADMIN"),
        &admin_token,
        None,
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);
}
