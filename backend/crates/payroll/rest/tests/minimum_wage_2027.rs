// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "fixtures/pay_view.rs"]
mod pay_view;
#[path = "support/payslip_seed_user.rs"]
mod payslip_seed_user;

use axum::body::{Body, to_bytes};
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use console_payroll_adapter_postgres::PgPayrollStore;
use console_payroll_rest::{PayrollRestState, router};
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use console_platform_db::{DbError, with_audit};
use console_platform_test_support::runtime_role_pool;
use http::{Request, StatusCode, header};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::Generate;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use uuid::Uuid;

const TEST_ISSUER: &str = "console-platform-auth";
const TEST_AUDIENCE: &str = "console-api";

fn seed_event(action: &str, target_type: &str, target_id: impl ToString, org: Uuid) -> AuditEvent {
    AuditEvent::new(
        None,
        AuditAction::new(action).unwrap(),
        target_type,
        target_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(OrgId::from_uuid(org))
}

struct Keys {
    private_pem: String,
    public_pem: String,
}

fn keys() -> Keys {
    let signing_key = SigningKey::generate();
    Keys {
        private_pem: signing_key
            .to_pkcs8_pem(LineEnding::LF)
            .unwrap()
            .to_string(),
        public_pem: signing_key
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap(),
    }
}

async fn bearer(pool: &PgPool, keys: &Keys, user_id: UserId, org: OrgId, role: &str) -> String {
    let issuer = JwtIssuer::from_es256_pem(
        JwtSettings {
            issuer: TEST_ISSUER.to_owned(),
            audience: TEST_AUDIENCE.to_owned(),
            access_token_ttl: Duration::minutes(15),
        },
        keys.private_pem.as_bytes(),
        keys.public_pem.as_bytes(),
    )
    .unwrap();
    console_platform_test_support::issue_session_token(
        pool,
        &issuer,
        AccessTokenInput {
            subject: user_id,
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

fn app(pool: PgPool, keys: &Keys) -> axum::Router {
    let verifier = JwtVerifier::from_es256_public_pem(
        JwtSettings {
            issuer: TEST_ISSUER.to_owned(),
            audience: TEST_AUDIENCE.to_owned(),
            access_token_ttl: Duration::minutes(15),
        },
        keys.public_pem.as_bytes(),
    )
    .unwrap();
    router(PayrollRestState::new(
        PgPayrollStore::new(pool),
        Some(verifier),
    ))
}

async fn call(
    service: axum::Router,
    method: &str,
    uri: &str,
    token: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .uri(uri)
        .method(method)
        .header(header::AUTHORIZATION, format!("Bearer {token}"));
    let body = match body {
        Some(v) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(v.to_string())
        }
        None => Body::empty(),
    };
    let response = service.oneshot(builder.body(body).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({})),
    )
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn payslip_draft_applies_2026_vs_2027_minimum_wage_floors_dynamically(owner_pool: PgPool) {
    let pool = runtime_role_pool(&owner_pool).await;
    let keys = keys();
    let org = OrgId::one();
    let actor = UserId::new();

    with_audit(
        &owner_pool,
        AuditEvent::new(
            None,
            AuditAction::new("test.seed_org").unwrap(),
            "organization",
            org.as_uuid().to_string(),
            TraceContext::generate(),
            OffsetDateTime::now_utc(),
        )
        .with_org(org),
        |tx| {
            Box::pin(async move {
                sqlx::query(
                    "INSERT INTO organizations (id, slug, name) VALUES ($1, 'org-mw27', 'Org MW27') \
                     ON CONFLICT (id) DO NOTHING",
                )
                .bind(*org.as_uuid())
                .execute(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)?;
                Ok::<(), DbError>(())
            })
        },
    )
    .await
    .unwrap();
    payslip_seed_user::seed_user(&owner_pool, actor, *org.as_uuid(), "EXECUTIVE").await;
    pay_view::grant_manage(&owner_pool, org, actor, None).await;

    let employee = Uuid::new_v4();
    with_audit(
        &owner_pool,
        AuditEvent::new(
            None,
            AuditAction::new("test.seed_employee").unwrap(),
            "employee",
            employee.to_string(),
            TraceContext::generate(),
            OffsetDateTime::now_utc(),
        )
        .with_org(org),
        |tx| {
            Box::pin(async move {
                sqlx::query(
                    "INSERT INTO employees \
                     (id, org_id, company, name, source_filename, source_sheet, source_row, source_key) \
                     VALUES ($1, $2, 'SAE', 'Kim Worker', 'roster.xlsx', 'Sheet1', 1, $3)",
                )
                .bind(employee)
                .bind(*org.as_uuid())
                .bind(format!("emp-{employee}"))
                .execute(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)?;
                Ok::<(), DbError>(())
            })
        },
    )
    .await
    .unwrap();

    let token = bearer(&owner_pool, &keys, actor, org, "EXECUTIVE").await;
    let (wage_status, wage_body) = call(
        app(pool.clone(), &keys),
        "POST",
        &format!("/api/v1/payroll/employees/{employee}/contract-wages"),
        &token,
        Some(json!({
            "effective_from": "2026-01-01",
            "wage_kind": "MONTHLY",
            "amount_won": 2_200_000,
            "monthly_standard_hours": 209,
        })),
    )
    .await;
    assert_eq!(wage_status, StatusCode::CREATED, "{wage_body}");

    // 2026-12-10: 2,200,000 / 209 = 10,526 >= 10,320 -> passes under 2025-47
    let (s26, d26) = call(
        app(pool.clone(), &keys),
        "GET",
        &format!(
            "/api/v1/payroll/employees/{employee}/payslip-draft\
             ?period_start=2026-12-01&period_end=2026-12-31&pay_date=2026-12-10"
        ),
        &token,
        None,
    )
    .await;
    assert_eq!(s26, StatusCode::OK, "{d26}");
    assert_eq!(d26["minimum_wage_check"]["hourly_floor_won"], 10_320);
    assert_eq!(d26["minimum_wage_check"]["passes"], true);
    assert!(
        d26["minimum_wage_check"]["instrument"]["promulgation_ko"]
            .as_str()
            .unwrap()
            .contains("2025-47"),
        "{d26}"
    );
    assert!(
        !d26["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b == "MINIMUM_WAGE_BELOW_FLOOR"),
        "{d26}"
    );

    // 2027-01-15: 2,200,000 / 209 = 10,526 < 10,700 -> emits MINIMUM_WAGE_BELOW_FLOOR under 2026-60
    let (s27, d27) = call(
        app(pool, &keys),
        "GET",
        &format!(
            "/api/v1/payroll/employees/{employee}/payslip-draft\
             ?period_start=2027-01-01&period_end=2027-01-31&pay_date=2027-01-15"
        ),
        &token,
        None,
    )
    .await;
    assert_eq!(s27, StatusCode::OK, "{d27}");
    assert_eq!(d27["minimum_wage_check"]["hourly_floor_won"], 10_700);
    assert_eq!(d27["minimum_wage_check"]["passes"], false);
    assert!(
        d27["minimum_wage_check"]["instrument"]["promulgation_ko"]
            .as_str()
            .unwrap()
            .contains("2026-60"),
        "{d27}"
    );
    assert!(
        d27["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b == "MINIMUM_WAGE_BELOW_FLOOR"),
        "{d27}"
    );
}
