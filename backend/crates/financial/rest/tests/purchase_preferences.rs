// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use console_financial_adapter_postgres::PgFinancialStore;
use console_financial_rest::{
    FINANCIAL_PURCHASE_REQUEST_PREFERENCES_PATH, FinancialRestState, router,
};
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use console_platform_test_support::{issue_session_token, runtime_role_pool, seed_active_user};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;

fn settings() -> JwtSettings {
    JwtSettings {
        issuer: "console-platform-auth".to_owned(),
        audience: "console-api".to_owned(),
        access_token_ttl: Duration::minutes(15),
    }
}

async fn token(pool: &PgPool, issuer: &JwtIssuer, user: UserId, roles: Vec<String>) -> String {
    issue_session_token(
        pool,
        issuer,
        AccessTokenInput {
            subject: user,
            org_id: OrgId::one(),
            roles,
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

async fn save(service: axum::Router, token: &str) -> (StatusCode, Value) {
    let response = service
        .oneshot(
            Request::put(FINANCIAL_PURCHASE_REQUEST_PREFERENCES_PATH)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({"schema_version": 1, "preferences": {"density": "compact"}}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn preferences_require_current_workspace_authority_before_storage(pool: PgPool) {
    let key = SigningKey::random(&mut OsRng);
    let private = key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public = key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let issuer =
        JwtIssuer::from_es256_pem(settings(), private.as_bytes(), public.as_bytes()).unwrap();
    let verifier = JwtVerifier::from_es256_public_pem(settings(), public.as_bytes()).unwrap();
    let service = router(FinancialRestState::new(
        PgFinancialStore::new(runtime_role_pool(&pool).await),
        Some(verifier),
    ));
    let org = *OrgId::one().as_uuid();
    let member = seed_active_user(&pool, org, "MEMBER", "preferences").await;
    let bearer = token(&pool, &issuer, member, vec!["MEMBER".to_owned()]).await;
    let (status, body) = save(service.clone(), &bearer).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "purchase_preferences_forbidden");
    let stored: i64 =
        sqlx::query_scalar("SELECT count(*) FROM user_feature_preferences WHERE user_id = $1")
            .bind(member.as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(stored, 0);

    let region: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO regions (org_id, name) VALUES ($1, 'Purchase region') RETURNING id",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .unwrap();
    let branch: uuid::Uuid = sqlx::query_scalar("INSERT INTO branches (org_id, region_id, name) VALUES ($1, $2, 'Purchase branch') RETURNING id")
        .bind(org).bind(region).fetch_one(&pool).await.unwrap();
    sqlx::query("INSERT INTO user_branches (org_id, user_id, branch_id) VALUES ($1, $2, $3)")
        .bind(org)
        .bind(member.as_uuid())
        .bind(branch)
        .execute(&pool)
        .await
        .unwrap();
    let role: uuid::Uuid = sqlx::query_scalar("INSERT INTO policy_roles (org_id, role_key, display_name, status, is_system) VALUES ($1, 'purchase_reader', 'Purchase reader', 'ACTIVE', false) RETURNING id")
        .bind(org).fetch_one(&pool).await.unwrap();
    sqlx::query("INSERT INTO policy_role_permissions (org_id, role_id, feature_key, permission_level) VALUES ($1, $2, 'purchase_request_read', 'limited')")
        .bind(org).bind(role).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO user_role_assignments (org_id, user_id, role_id) VALUES ($1, $2, $3)")
        .bind(org)
        .bind(member.as_uuid())
        .bind(role)
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = save(service.clone(), &bearer).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    sqlx::query("UPDATE policy_roles SET status = 'RETIRED' WHERE id = $1")
        .bind(role)
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = save(service.clone(), &bearer).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "purchase_preferences_forbidden");

    for role in [
        "RECEPTIONIST",
        "MECHANIC",
        "ADMIN",
        "EXECUTIVE",
        "SUPER_ADMIN",
    ] {
        let reader = seed_active_user(&pool, org, role, "preferences").await;
        // A still-valid token may predate an added role; the loader owns authority.
        let bearer = token(&pool, &issuer, reader, Vec::new()).await;
        let (status, body) = save(service.clone(), &bearer).await;
        assert_eq!(status, StatusCode::OK, "{role}: {body}");
        assert_eq!(body["preferences"], json!({"density": "compact"}));
        let stored: Value = sqlx::query_scalar("SELECT preferences_json FROM user_feature_preferences WHERE user_id = $1 AND org_id = $2")
            .bind(reader.as_uuid()).bind(org).fetch_one(&pool).await.unwrap();
        assert_eq!(stored, body["preferences"]);
    }

    // Revocation applies to an existing row as well as the first save.
    let reader = seed_active_user(&pool, org, "RECEPTIONIST", "preferences-revocation").await;
    let bearer = token(&pool, &issuer, reader, Vec::new()).await;
    assert_eq!(save(service.clone(), &bearer).await.0, StatusCode::OK);
    let saved_at: OffsetDateTime =
        sqlx::query_scalar("SELECT updated_at FROM user_feature_preferences WHERE user_id = $1")
            .bind(reader.as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
    sqlx::query("UPDATE users SET roles = ARRAY['MEMBER'] WHERE id = $1")
        .bind(reader.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = save(service, &bearer).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "purchase_preferences_forbidden");
    let refused_at: OffsetDateTime =
        sqlx::query_scalar("SELECT updated_at FROM user_feature_preferences WHERE user_id = $1")
            .bind(reader.as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(saved_at, refused_at);
}
