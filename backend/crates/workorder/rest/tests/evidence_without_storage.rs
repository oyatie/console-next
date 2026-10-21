//! PV-2: a preview (or any api) runs with no object storage (`CONSOLE_S3_*`
//! unset). Evidence then fails closed: 503 with a clear message, nothing
//! written, never a 500 or a half-made record.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::body::{Body, to_bytes};
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use console_platform_storage::SeaweedS3Storage;
use console_platform_test_support::runtime_role_pool;
use console_workorder_adapter_postgres::PgWorkOrderStore;
use console_workorder_rest::{MobileRestState, mobile_router};
use http::{Request, StatusCode, header};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;

#[path = "../../../../test_support/mobile_evidence_fixtures.rs"]
#[allow(dead_code)]
mod mobile_evidence_fixtures;

use mobile_evidence_fixtures::{
    seed_assigned_work_order, seed_branch, seed_equipment, seed_user_with_branch,
};

fn settings() -> JwtSettings {
    JwtSettings {
        issuer: "console-platform-auth".to_owned(),
        audience: "console-api".to_owned(),
        access_token_ttl: Duration::minutes(15),
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn evidence_presign_without_object_storage_is_503_and_writes_nothing(pool: PgPool) {
    console_platform_request_context::scope_org(OrgId::one(), async move {
        let key = SigningKey::random(&mut OsRng);
        let private_pem = key.to_pkcs8_pem(LineEnding::LF).unwrap();
        let public_pem = key
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap();
        let branch_id = seed_branch(&pool, "PV-2 Region", "PV-2 Branch").await;
        let (mechanic, receptionist) = (UserId::new(), UserId::new());
        seed_user_with_branch(&pool, mechanic, "MECHANIC", branch_id).await;
        seed_user_with_branch(&pool, receptionist, "RECEPTIONIST", branch_id).await;
        let equipment_id = seed_equipment(&pool, branch_id, "293").await;
        let work_order_id =
            seed_assigned_work_order(&pool, branch_id, equipment_id, receptionist, mechanic).await;
        let issuer =
            JwtIssuer::from_es256_pem(settings(), private_pem.as_bytes(), public_pem.as_bytes())
                .unwrap();
        let token = console_platform_test_support::issue_session_token(
            &pool,
            &issuer,
            AccessTokenInput {
                subject: mechanic,
                org_id: OrgId::one(),
                roles: vec!["MECHANIC".to_owned()],
                branches: vec![branch_id],
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
        .await;
        let verifier =
            JwtVerifier::from_es256_public_pem(settings(), public_pem.as_bytes()).unwrap();
        let rt_pool = runtime_role_pool(&pool).await;
        // The production type, unconfigured (no CONSOLE_S3_*).
        let service = mobile_router(MobileRestState::<SeaweedS3Storage>::new(
            rt_pool.clone(),
            PgWorkOrderStore::new(rt_pool),
            Some(verifier),
            None,
        ));

        let response = service
            .oneshot(
                Request::post("/api/v1/evidence/presign")
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "work_order_id": work_order_id,
                            "stage": "BEFORE",
                            "content_type": "image/jpeg",
                            "size_bytes": 1024
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert!(
            body["error"]["message"]
                .as_str()
                .is_some_and(|message| message.contains("not configured")),
            "{body}"
        );
        let rows: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM evidence_media WHERE work_order_id = $1")
                .bind(*work_order_id.as_uuid())
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(rows, 0);
    })
    .await;
}
