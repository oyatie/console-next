// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::body::{Body, to_bytes};
use console_kernel_core::{BranchId, OrgId, UserId};
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use console_platform_storage::SeaweedS3Storage;
use console_platform_test_support::runtime_role_pool;
use console_workorder_adapter_postgres::PgWorkOrderStore;
use console_workorder_rest::{MobileRestState, mobile_router};
use http::{Request, StatusCode, header};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::Generate;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;

#[path = "../../../../test_support/mobile_evidence_fixtures.rs"]
#[allow(dead_code)]
mod mobile_evidence_fixtures;

use mobile_evidence_fixtures::{
    seed_assigned_work_order, seed_branch, seed_equipment, seed_user_with_branch,
};

fn jwt_settings() -> JwtSettings {
    JwtSettings {
        issuer: "console-platform-auth".to_owned(),
        audience: "console-api".to_owned(),
        access_token_ttl: Duration::minutes(15),
    }
}

async fn issue_token(
    pool: &PgPool,
    issuer: &JwtIssuer,
    subject: UserId,
    roles: &[&str],
    branch: BranchId,
) -> String {
    console_platform_test_support::issue_session_token(
        pool,
        issuer,
        AccessTokenInput {
            subject,
            org_id: OrgId::one(),
            roles: roles.iter().map(|role| (*role).to_owned()).collect(),
            branches: vec![branch],
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

async fn post_sync(service: axum::Router, token: &str, body: &Value) -> (StatusCode, Value) {
    let response = service
        .oneshot(
            Request::post("/api/v1/sync")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .header("x-device-id", "authz-test-device")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    (status, body)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn zero_grant_member_is_refused_before_claiming_sync_batch(pool: PgPool) {
    console_platform_request_context::scope_org(OrgId::one(), async move {
        let key = SigningKey::generate();
        let private_pem = key.to_pkcs8_pem(LineEnding::LF).unwrap();
        let public_pem = key
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap();
        let issuer = JwtIssuer::from_es256_pem(
            jwt_settings(),
            private_pem.as_bytes(),
            public_pem.as_bytes(),
        )
        .unwrap();
        let branch = seed_branch(&pool, "Refusal Region", "Refusal Branch").await;
        let (member, mechanic, receptionist) = (UserId::new(), UserId::new(), UserId::new());
        seed_user_with_branch(&pool, member, "MEMBER", branch).await;
        seed_user_with_branch(&pool, mechanic, "MECHANIC", branch).await;
        seed_user_with_branch(&pool, receptionist, "RECEPTIONIST", branch).await;
        let equipment = seed_equipment(&pool, branch, "502").await;
        let work_order =
            seed_assigned_work_order(&pool, branch, equipment, receptionist, mechanic).await;
        let member_token = issue_token(&pool, &issuer, member, &["MEMBER"], branch).await;
        let mechanic_token = issue_token(&pool, &issuer, mechanic, &["MECHANIC"], branch).await;
        let earlier_token = issue_token(&pool, &issuer, mechanic, &[], branch).await;
        let verifier =
            JwtVerifier::from_es256_public_pem(jwt_settings(), public_pem.as_bytes()).unwrap();
        let runtime_pool = runtime_role_pool(&pool).await;
        let service = mobile_router(MobileRestState::<SeaweedS3Storage>::new(
            runtime_pool.clone(),
            PgWorkOrderStore::new(runtime_pool),
            Some(verifier),
            None,
        ));
        let body = json!({
            "sync_id": "sync-member-refused",
            "operations": [{
                "request_id": "op-member-1",
                "operation": "WORK_ORDER_START",
                "created_at": OffsetDateTime::now_utc().format(&Rfc3339).unwrap(),
                "payload": { "work_order_id": work_order }
            }]
        });

        let (status, refused) = post_sync(service.clone(), &member_token, &body).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
        assert_eq!(refused["error"]["code"], "mobile_sync_forbidden");
        let claimed: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM offline_sync_requests WHERE sync_id = 'sync-member-refused'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(claimed, 0, "refused callers must not claim sync batch rows");

        let (status, allowed) = post_sync(service.clone(), &mechanic_token, &body).await;
        assert_eq!(status, StatusCode::OK, "{allowed}");
        assert_eq!(allowed["results"][0]["status"], "APPLIED");

        let (status, replay) = post_sync(service, &earlier_token, &body).await;
        assert_eq!(status, StatusCode::OK, "{replay}");
        assert_eq!(replay["results"][0]["status"], "APPLIED");
    })
    .await;
}
