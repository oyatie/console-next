#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Finance-GL voucher separation-of-duties + impersonation-wall integration
//! tests, driven through the REAL assembled app router (`build_router`).
//!
//! Proves, end-to-end over the wired stack:
//!   (a) SoD (M2) — a preparer's own `승인` is rejected 403 at the REST surface; a
//!       DISTINCT approver clears it and the approver is recorded on the response;
//!   (b) coverage-gap #3 — a PLATFORM `support` (read-only impersonation) token is
//!       rejected 403 `support_read_only` on EVERY finance voucher mutation
//!       (create/submit/approve/post/reverse), blocked by the blanket method wall
//!       BEFORE any handler runs.
//!
//! DB-backed work runs against a pool whose connections `SET ROLE console_rt`, so RLS
//! is exercised as the production runtime role (rls-verify-as-runtime-role).

use axum::body::{Body, to_bytes};
use console_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use console_kernel_core::{BranchId, OrgId, UserId};
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings};
use http::{Request, StatusCode, header};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use uuid::Uuid;

const TEST_ISSUER: &str = "console-platform-auth";
const TEST_AUDIENCE: &str = "console-api";

const VOUCHERS_PATH: &str = "/api/v1/finance-gl/vouchers";

/// SoD at the REST surface: the 기표자 cannot approve their own voucher (403); a
/// distinct approver can, and the recorded approver is surfaced on the response.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rest_rejects_self_approval_and_accepts_distinct_approver(pool: PgPool) {
    let keys = Keys::generate();
    let rt = runtime_role_pool(&pool).await;

    let branch = seed_branch(&pool, "Region A", "Branch A").await;
    let creator = UserId::new();
    let approver = UserId::new();
    seed_user_in_branch(&pool, creator, "ADMIN", branch).await;
    seed_user_in_branch(&pool, approver, "ADMIN", branch).await;
    let creator_token = keys.token(&pool, creator, vec![branch], false).await;
    let approver_token = keys.token(&pool, approver, vec![branch], false).await;

    // 기표: create a balanced draft.
    let (status, created) = send(
        &rt,
        &keys,
        "POST",
        VOUCHERS_PATH,
        &creator_token,
        Some(json!({
            "branch_id": branch.as_uuid().to_string(),
            "memo": "SoD test",
            "lines": [
                {"account_code": "1000", "side": "DEBIT", "amount_won": 9000},
                {"account_code": "4000", "side": "CREDIT", "amount_won": 9000},
            ],
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "create draft: {created}");
    let voucher_id = created["id"].as_str().unwrap().to_owned();
    assert_eq!(created["approved_by"], Value::Null);

    // 제출: 기표 → 차대검증.
    let (status, _) = send(
        &rt,
        &keys,
        "POST",
        &format!("{VOUCHERS_PATH}/{voucher_id}/submit"),
        &creator_token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // 승인 by the preparer → 403 forbidden (self-approval barred).
    let (status, body) = send(
        &rt,
        &keys,
        "POST",
        &format!("{VOUCHERS_PATH}/{voucher_id}/approve"),
        &creator_token,
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "preparer self-approval must be 403: {body}"
    );
    assert_eq!(body["error"]["code"], "forbidden");

    // 승인 by a DISTINCT approver → 200, approver recorded.
    let (status, approved) = send(
        &rt,
        &keys,
        "POST",
        &format!("{VOUCHERS_PATH}/{voucher_id}/approve"),
        &approver_token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "distinct approver: {approved}");
    assert_eq!(approved["status"], "APPROVED");
    assert_eq!(
        approved["approved_by"].as_str().unwrap(),
        approver.as_uuid().to_string()
    );

    // 전기: posts and keeps the approver.
    let (status, posted) = send(
        &rt,
        &keys,
        "POST",
        &format!("{VOUCHERS_PATH}/{voucher_id}/post"),
        &creator_token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "post: {posted}");
    assert_eq!(posted["status"], "POSTED");
    assert_eq!(
        posted["approved_by"].as_str().unwrap(),
        approver.as_uuid().to_string()
    );
}

/// Coverage-gap #3: a `support` token is read-only — EVERY finance voucher
/// mutation is rejected 403 `support_read_only` by the blanket method wall before
/// any handler (and any per-handler authz) runs. No DB rows are needed: the wall
/// rejects on method + token claim ahead of the tenant middleware.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn support_token_cannot_mutate_finance_vouchers(pool: PgPool) {
    let keys = Keys::generate();
    let rt = runtime_role_pool(&pool).await;

    // A read-only impersonation token (support = true) for any tenant/user.
    let support_token = keys.token(&pool, UserId::new(), Vec::new(), true).await;

    let id = Uuid::new_v4();
    let mutations = [
        ("POST", VOUCHERS_PATH.to_owned()),
        ("POST", format!("{VOUCHERS_PATH}/{id}/submit")),
        ("POST", format!("{VOUCHERS_PATH}/{id}/approve")),
        ("POST", format!("{VOUCHERS_PATH}/{id}/post")),
        ("POST", format!("{VOUCHERS_PATH}/{id}/reverse")),
    ];

    for (method, path) in mutations {
        let (status, body) = send(&rt, &keys, method, &path, &support_token, None).await;
        assert_eq!(
            status,
            StatusCode::FORBIDDEN,
            "{method} {path} under support must be 403: {body}"
        );
        assert_eq!(
            body["error"]["code"], "support_read_only",
            "{method} {path} must be blocked by the read-only wall, not a plain \
             authz denial: {body}"
        );
    }
}

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

struct Keys {
    private_pem: String,
    public_pem: String,
}

impl Keys {
    fn generate() -> Self {
        let signing_key = SigningKey::random(&mut OsRng);
        Self {
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

    async fn token(
        &self,
        pool: &sqlx::PgPool,
        user_id: UserId,
        branches: Vec<BranchId>,
        support: bool,
    ) -> String {
        let issuer = JwtIssuer::from_es256_pem(
            JwtSettings {
                issuer: TEST_ISSUER.to_owned(),
                audience: TEST_AUDIENCE.to_owned(),
                access_token_ttl: Duration::minutes(15),
            },
            self.private_pem.as_bytes(),
            self.public_pem.as_bytes(),
        )
        .unwrap();
        let input = AccessTokenInput {
            subject: user_id,
            org_id: OrgId::one(),
            roles: vec!["ADMIN".to_owned()],
            branches,
            platform: false,
            support,
            read_only: support,
            display_name: None,
            feature_grants: Vec::new(),
            authz_subject_version: 0,
            authz_policy_version: 0,
            session_generation: 0,
            issued_at: OffsetDateTime::now_utc(),
        };
        // The support wall refuses on the claim alone, before any session check,
        // so that token needs no account or family behind it.
        if support {
            return issuer.issue_access_token(input).unwrap();
        }
        console_platform_test_support::issue_session_token(pool, &issuer, input, None, Vec::new())
            .await
    }
}

async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(4)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_rt").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .unwrap()
}

async fn send(
    pool: &PgPool,
    keys: &Keys,
    method: &str,
    uri: &str,
    token: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let service = build_router(app_state(pool.clone(), keys.public_pem.clone()).unwrap());
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(match body {
            Some(value) => Body::from(serde_json::to_vec(&value).unwrap()),
            None => Body::empty(),
        })
        .unwrap();
    let response = service.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, json)
}

async fn seed_branch(pool: &PgPool, region: &str, branch: &str) -> BranchId {
    let region_id: Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind(region)
            .bind(*OrgId::one().as_uuid())
            .fetch_one(pool)
            .await
            .unwrap();
    let branch_id: Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(region_id)
    .bind(branch)
    .bind(*OrgId::one().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    BranchId::from_uuid(branch_id)
}

async fn seed_user_in_branch(pool: &PgPool, user_id: UserId, role: &str, branch: BranchId) {
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(*user_id.as_uuid())
        .bind(format!("User {role} {}", Uuid::new_v4()))
        .bind(Vec::from([role]))
        .bind(*OrgId::one().as_uuid())
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
        .bind(*user_id.as_uuid())
        .bind(*branch.as_uuid())
        .bind(*OrgId::one().as_uuid())
        .execute(pool)
        .await
        .unwrap();
}

fn app_state(pool: PgPool, public_key_pem: String) -> Result<AppState, console_app::AppError> {
    let config = AppConfig::from_pairs([
        ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ("CONSOLE_JWT_ISSUER", TEST_ISSUER.to_owned()),
        ("CONSOLE_JWT_AUDIENCE", TEST_AUDIENCE.to_owned()),
        ("CONSOLE_JWT_PUBLIC_KEY_PEM", public_key_pem),
    ])?;
    AppState::new(config, DatabaseDependency::Postgres(pool))
}
