#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Real-router proof for the self-service/managed leave boundary.
//!
//! Requests use signed JWTs and a genuine `console_rt` pool. This locks three
//! invariants at the transport boundary: self reads never require directory
//! authority, managed reads remain denied to a member, and client-supplied
//! employee/branch identifiers cannot influence filing.

#[path = "fixtures/leave_http_people.rs"]
mod people;
#[path = "../../../../test-support/person_fixtures.rs"]
mod person_fixtures;
use people::{seed_branch_admin, seed_subject};
use std::sync::Arc;

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use console_inbox_adapter_postgres::PgInboxStore;
use console_kernel_core::{BranchId, OrgId, UserId};
use console_leave_adapter_postgres::PgLeaveStore;
use console_leave_domain::{PromotionTrack, first_round_window};
use console_leave_rest::{LeaveRestState, router};
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use console_platform_test_support::{grant_console_rt, runtime_role_pool};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::{Duration, OffsetDateTime, UtcOffset};
use tower::ServiceExt;
use uuid::Uuid;

const TEST_ISSUER: &str = "console-platform-auth";
const TEST_AUDIENCE: &str = "console-api";

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn member_self_service_is_server_bound_and_missing_home_branch_is_explicit(
    owner_pool: PgPool,
) {
    let org = OrgId::new();
    let branch = BranchId::new();
    let member = UserId::new();
    let employee = Uuid::new_v4();
    seed_subject(&owner_pool, org, branch, member, employee).await;
    grant_console_rt(
        &owner_pool,
        &[
            "GRANT SELECT, INSERT, UPDATE ON leave_requests TO console_rt",
            "GRANT SELECT, INSERT ON leave_charge_resolutions TO console_rt",
            "GRANT SELECT, INSERT ON audit_events TO console_rt",
            "GRANT SELECT, UPDATE ON employees TO console_rt",
            "GRANT SELECT ON users TO console_rt",
            "GRANT SELECT ON user_branches TO console_rt",
            "GRANT SELECT ON branches TO console_rt",
            "GRANT SELECT ON organizations TO console_rt",
        ],
    )
    .await;

    let auth = test_auth(&owner_pool, member, org, vec![branch]).await;
    let runtime_pool = runtime_role_pool(&owner_pool).await;
    let service = router(LeaveRestState::new(
        PgLeaveStore::new(
            runtime_pool.clone(),
            Arc::new(PgInboxStore::new(runtime_pool)),
        ),
        Some(auth.verifier),
    ));

    let own = request_json(
        service.clone(),
        "GET",
        "/api/v2/me/leave",
        &auth.token,
        None,
    )
    .await;
    assert_eq!(own.status, StatusCode::OK, "{:?}", own.body);
    assert_eq!(own.body["balance"]["employee_id"], employee.to_string());
    assert_eq!(own.body["balance"]["filing_state"], "ready");
    assert_eq!(
        own.body["balance"]["home_branch_id"],
        branch.as_uuid().to_string()
    );
    assert_eq!(own.body["requests"]["items"], json!([]));

    let managed = request_json(
        service.clone(),
        "GET",
        "/api/v2/leave/requests",
        &auth.token,
        None,
    )
    .await;
    assert_eq!(managed.status, StatusCode::FORBIDDEN, "{:?}", managed.body);

    let forged = request_json(
        service.clone(),
        "POST",
        "/api/v2/leave/requests",
        &auth.token,
        Some(json!({
            "leave_type": "annual",
            "idempotency_key": Uuid::new_v4(),
            "start_date": "2026-07-21",
            "end_date": "2026-07-21",
            "subject_employee_id": Uuid::new_v4(),
            "branch_id": Uuid::new_v4()
        })),
    )
    .await;
    assert_eq!(forged.status, StatusCode::UNPROCESSABLE_ENTITY);

    let definer_pool = leave_definer_role_pool(&owner_pool).await;
    sqlx::query("SELECT set_config('app.current_org', $1, false)")
        .bind(org.as_uuid().to_string())
        .execute(&definer_pool)
        .await
        .unwrap();
    sqlx::query("UPDATE employees SET home_branch_id = NULL WHERE org_id = $1 AND id = $2")
        .bind(*org.as_uuid())
        .bind(employee)
        .execute(&definer_pool)
        .await
        .unwrap();

    let readable_while_blocked = request_json(
        service.clone(),
        "GET",
        "/api/v2/me/leave",
        &auth.token,
        None,
    )
    .await;
    assert_eq!(readable_while_blocked.status, StatusCode::OK);
    assert_eq!(
        readable_while_blocked.body["balance"]["filing_state"],
        "home_branch_required"
    );
    assert!(readable_while_blocked.body["balance"]["home_branch_id"].is_null());

    let blocked = request_json(
        service.clone(),
        "POST",
        "/api/v2/leave/requests",
        &auth.token,
        Some(json!({
            "leave_type": "half_day",
            "idempotency_key": Uuid::new_v4(),
            "partial_day_period": "pm",
            "start_date": "2026-07-21",
            "end_date": "2026-07-21"
        })),
    )
    .await;
    assert_eq!(blocked.status, StatusCode::CONFLICT, "{:?}", blocked.body);
    assert_eq!(
        blocked.body["error"]["code"],
        "leave_home_branch_review_required"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn v1_wire_shape_is_frozen_and_v2_requires_modern_exact_cas(owner_pool: PgPool) {
    let org = OrgId::new();
    let branch = BranchId::new();
    let requester = UserId::new();
    let decider = UserId::new();
    let employee = Uuid::new_v4();
    seed_subject(&owner_pool, org, branch, requester, employee).await;
    seed_branch_admin(&owner_pool, org, branch, decider).await;
    grant_console_rt(
        &owner_pool,
        &[
            "GRANT SELECT ON leave_requests TO console_rt",
            "GRANT SELECT ON users TO console_rt",
            "GRANT SELECT ON user_branches TO console_rt",
            "GRANT SELECT ON branches TO console_rt",
            "GRANT SELECT ON organizations TO console_rt",
        ],
    )
    .await;

    let v1_request = Uuid::new_v4();
    let modern_request = Uuid::new_v4();
    let definer_pool = leave_definer_role_pool(&owner_pool).await;
    sqlx::query("SELECT set_config('app.current_org', $1, false)")
        .bind(org.as_uuid().to_string())
        .execute(&definer_pool)
        .await
        .unwrap();
    for id in [v1_request, modern_request] {
        sqlx::query(
            "INSERT INTO leave_requests \
             (id, org_id, branch_id, requester_user_id, subject_employee_id, leave_type, days, \
              start_date, end_date, status) \
             VALUES ($1, $2, $3, $4, $5, 'annual', 1, DATE '2026-10-01', \
                     DATE '2026-10-01', 'pending')",
        )
        .bind(id)
        .bind(*org.as_uuid())
        .bind(*branch.as_uuid())
        .bind(*requester.as_uuid())
        .bind(employee)
        .execute(&definer_pool)
        .await
        .unwrap();
    }

    let auth = test_auth_with_roles(&owner_pool, decider, org, vec![branch], vec!["ADMIN"]).await;
    let runtime_pool = runtime_role_pool(&owner_pool).await;
    let command_pool = leave_command_role_pool(&owner_pool).await;
    let service = router(LeaveRestState::new(
        PgLeaveStore::new(
            runtime_pool.clone(),
            Arc::new(PgInboxStore::new(runtime_pool)),
        )
        .with_leave_command_pool(command_pool),
        Some(auth.verifier),
    ));

    // 근로기준법 §60: refusal is not a decision — even the frozen v1 route must
    // fail closed rather than mint a 'rejected' row.
    let refusal = request_json(
        service.clone(),
        "POST",
        &format!("/api/v1/leave/requests/{v1_request}/decide"),
        &auth.token,
        Some(json!({"decision": "reject", "comment": "v1 reject"})),
    )
    .await;
    assert_eq!(
        refusal.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        refusal.body
    );

    // An unavailable fact resolver still produces the stable refusal over HTTP.
    sqlx::query("REVOKE EXECUTE ON FUNCTION public.console_decision_identities(UUID,UUID,UUID) FROM console_leave_cmd,console_leave_definer")
        .execute(&owner_pool).await.unwrap();
    let unknown = request_json(
        service.clone(),
        "POST",
        &format!("/api/v1/leave/requests/{v1_request}/decide"),
        &auth.token,
        Some(json!({"decision": "time_change", "comment": "신원 미확인"})),
    )
    .await;
    assert_eq!(unknown.status, StatusCode::FORBIDDEN);
    assert_eq!(
        unknown.body["error"]["code"],
        "leave_decide_requester_forbidden"
    );
    sqlx::query("GRANT EXECUTE ON FUNCTION public.console_decision_identities(UUID,UUID,UUID) TO console_leave_cmd,console_leave_definer")
        .execute(&owner_pool).await.unwrap();

    // A known unbound decider uses account identity without changing the frozen v1 response.
    let versionless = request_json(
        service.clone(),
        "POST",
        &format!("/api/v1/leave/requests/{v1_request}/decide"),
        &auth.token,
        Some(json!({"decision": "time_change", "comment": "성수기 — 시기 변경 협의"})),
    )
    .await;
    assert_eq!(versionless.status, StatusCode::OK, "{:?}", versionless.body);
    assert_eq!(versionless.body["status"], "time_change_consult");
    let legacy_keys = versionless
        .body
        .as_object()
        .expect("v1 decision response must be an object")
        .keys()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        legacy_keys,
        std::collections::BTreeSet::from([
            "branch_id",
            "created_at",
            "days",
            "decided_at",
            "decided_by",
            "decision_comment",
            "end_date",
            "id",
            "leave_type",
            "reason",
            "requester_user_id",
            "start_date",
            "status",
            "subject_employee_id",
        ]),
        "v1 must remain byte-shape compatible with the deployed strict client"
    );

    let repeated = request_json(
        service.clone(),
        "POST",
        &format!("/api/v1/leave/requests/{v1_request}/decide"),
        &auth.token,
        Some(json!({"decision": "time_change", "comment": "repeated"})),
    )
    .await;
    assert_eq!(repeated.status, StatusCode::CONFLICT, "{:?}", repeated.body);
    assert_eq!(repeated.body["error"]["code"], "conflict");

    let stale_modern = request_json(
        service.clone(),
        "POST",
        &format!("/api/v2/leave/requests/{modern_request}/decide"),
        &auth.token,
        Some(json!({
            "expected_version": 99,
            "decision": "time_change",
            "comment": "stale"
        })),
    )
    .await;
    assert_eq!(
        stale_modern.status,
        StatusCode::CONFLICT,
        "{:?}",
        stale_modern.body
    );
    assert_eq!(
        stale_modern.body["error"]["code"],
        "leave_concurrent_modification"
    );

    let legacy_page = request_json(
        service.clone(),
        "GET",
        "/api/v1/leave/requests",
        &auth.token,
        None,
    )
    .await;
    assert_eq!(legacy_page.status, StatusCode::OK, "{:?}", legacy_page.body);
    assert!(legacy_page.body.get("next_cursor").is_none());
    assert!(
        legacy_page.body["items"][0]
            .get("request_version")
            .is_none()
    );

    let v2_page = request_json(service, "GET", "/api/v2/leave/requests", &auth.token, None).await;
    assert_eq!(v2_page.status, StatusCode::OK, "{:?}", v2_page.body);
    assert!(v2_page.body.get("next_cursor").is_some());
    assert!(v2_page.body["items"][0].get("request_version").is_some());
}

/// 근로기준법 제61조 at the transport boundary.
///
/// The store enforces the windows (see the adapter's runtime-role proof); this
/// pins what the HTTP contract now demands of a caller: the statutory inputs
/// the windows are counted from are required, the unused-day count is no longer
/// accepted from the client, and a push outside its window is refused with the
/// canonical envelope instead of delivering a legally void notice.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn statutory_push_requires_its_statutory_inputs_over_http(owner_pool: PgPool) {
    let org = OrgId::new();
    let branch = BranchId::new();
    let target = UserId::new();
    let employee = Uuid::new_v4();
    let admin = UserId::new();
    seed_subject(&owner_pool, org, branch, target, employee).await;
    seed_branch_admin(&owner_pool, org, branch, admin).await;
    grant_console_rt(
        &owner_pool,
        &[
            "GRANT SELECT, INSERT ON audit_events TO console_rt",
            "GRANT SELECT ON employees TO console_rt",
            "GRANT SELECT ON users TO console_rt",
            "GRANT SELECT ON user_branches TO console_rt",
            "GRANT SELECT ON branches TO console_rt",
            "GRANT SELECT ON organizations TO console_rt",
        ],
    )
    .await;

    let auth = test_auth_with_roles(&owner_pool, admin, org, vec![branch], vec!["ADMIN"]).await;
    let runtime_pool = runtime_role_pool(&owner_pool).await;
    let service = router(LeaveRestState::new(
        PgLeaveStore::new(
            runtime_pool.clone(),
            Arc::new(PgInboxStore::new(runtime_pool)),
        ),
        Some(auth.verifier),
    ));

    // The handler stamps `occurred_at` from the clock, so the happy path picks a
    // 연차 사용기간 whose 1차 촉구 window (§61①1) contains today. Derived, never
    // hard-coded — a literal date would rot into a wall-clock time bomb.
    let today = OffsetDateTime::now_utc()
        .to_offset(UtcOffset::from_hms(9, 0, 0).unwrap())
        .date();
    let period_end = (150..=200)
        .map(|days| today + Duration::days(days))
        .find(|end| {
            first_round_window(PromotionTrack::Annual, *end)
                .is_ok_and(|window| window.contains(today))
        })
        .expect("some 사용기간 within six months opens its 1차 촉구 window today");

    // The body the console sends today: an unverifiable client float, and none
    // of the statutory inputs. It must be refused, not silently defaulted.
    let legacy = request_json(
        service.clone(),
        "POST",
        "/api/v1/leave/promotions",
        &auth.token,
        Some(json!({
            "branch_id": branch.as_uuid(),
            "target_user_id": target.as_uuid(),
            "target_employee_id": employee,
            "target_name": "홍길동",
            "round": 1,
            "unused_days": 13.0
        })),
    )
    .await;
    assert_eq!(
        legacy.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        legacy.body
    );

    let unknown_track = request_json(
        service.clone(),
        "POST",
        "/api/v1/leave/promotions",
        &auth.token,
        Some(json!({
            "branch_id": branch.as_uuid(),
            "target_user_id": target.as_uuid(),
            "target_employee_id": employee,
            "target_name": "홍길동",
            "round": 1,
            "track": "annual_leave",
            "leave_period_end": period_end.to_string()
        })),
    )
    .await;
    assert_eq!(
        unknown_track.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        unknown_track.body
    );
    assert_eq!(unknown_track.body["error"]["code"], "validation");

    // A 사용기간 whose window has not opened yet: refused, with the window in the
    // message so the operator can act on it.
    let out_of_window = request_json(
        service.clone(),
        "POST",
        "/api/v1/leave/promotions",
        &auth.token,
        Some(json!({
            "branch_id": branch.as_uuid(),
            "target_user_id": target.as_uuid(),
            "target_employee_id": employee,
            "target_name": "홍길동",
            "round": 1,
            "track": "annual",
            "leave_period_end": (period_end + Duration::days(60)).to_string()
        })),
    )
    .await;
    assert_eq!(
        out_of_window.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        out_of_window.body
    );
    assert_eq!(out_of_window.body["error"]["code"], "validation");
    assert!(
        out_of_window.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("1차 촉구는"),
        "{:?}",
        out_of_window.body
    );

    let served = request_json(
        service,
        "POST",
        "/api/v1/leave/promotions",
        &auth.token,
        Some(json!({
            "branch_id": branch.as_uuid(),
            "target_user_id": target.as_uuid(),
            "target_employee_id": employee,
            "target_name": "홍길동",
            "round": 1,
            "track": "annual",
            "leave_period_end": period_end.to_string()
        })),
    )
    .await;
    assert_eq!(served.status, StatusCode::OK, "{:?}", served.body);
    assert_eq!(served.body["round"], 1);
    assert_eq!(served.body["ap_submission"], "pending_engine_definition");

    // The delivered notice is receipt-gated, addressed to the target, and states
    // the roster's own 미사용 일수 — never the 13.0 the caller tried to supply.
    let (kind, notice_type, confirmed_at, payload): (
        String,
        String,
        Option<OffsetDateTime>,
        Value,
    ) = sqlx::query_as(
        "SELECT kind, notice_type, confirmed_at, payload FROM inbox_docs \
             WHERE id = $1 AND recipient_user_id = $2",
    )
    .bind(
        served.body["inbox_doc_id"]
            .as_str()
            .unwrap()
            .parse::<Uuid>()
            .unwrap(),
    )
    .bind(target.as_uuid())
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(kind, "legal_notice");
    assert_eq!(notice_type, "연차촉진");
    assert!(confirmed_at.is_none(), "receipt is not pre-stamped");
    assert_eq!(payload["unused_days"], json!("13"));
    assert_eq!(payload["leave_period_end"], json!(period_end.to_string()));
}

struct TestAuth {
    token: String,
    verifier: JwtVerifier,
}

async fn test_auth(
    pool: &sqlx::PgPool,
    user_id: UserId,
    org: OrgId,
    branches: Vec<BranchId>,
) -> TestAuth {
    test_auth_with_roles(pool, user_id, org, branches, vec!["MEMBER"]).await
}

async fn test_auth_with_roles(
    pool: &sqlx::PgPool,
    user_id: UserId,
    org: OrgId,
    branches: Vec<BranchId>,
    roles: Vec<&str>,
) -> TestAuth {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let settings = JwtSettings {
        issuer: TEST_ISSUER.to_owned(),
        audience: TEST_AUDIENCE.to_owned(),
        access_token_ttl: Duration::minutes(15),
    };
    let verifier =
        JwtVerifier::from_es256_public_pem(settings.clone(), public_pem.as_bytes()).unwrap();
    let issuer =
        JwtIssuer::from_es256_pem(settings, private_pem.as_bytes(), public_pem.as_bytes()).unwrap();
    let token = console_platform_test_support::issue_session_token(
        pool,
        &issuer,
        AccessTokenInput {
            subject: user_id,
            org_id: org,
            roles: roles.into_iter().map(str::to_owned).collect(),
            branches,
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
    .await;
    TestAuth { token, verifier }
}

async fn leave_command_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(1)
        .after_connect(|connection, _metadata| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_leave_cmd")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .unwrap()
}

async fn leave_definer_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(1)
        .after_connect(|connection, _metadata| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_leave_definer")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .unwrap()
}

struct JsonResponse {
    status: StatusCode,
    body: Value,
}

async fn request_json(
    service: axum::Router,
    method: &str,
    uri: &str,
    token: &str,
    body: Option<Value>,
) -> JsonResponse {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {token}"));
    let body = match body {
        Some(body) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(serde_json::to_vec(&body).unwrap())
        }
        None => Body::empty(),
    };
    let response = service.oneshot(builder.body(body).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    JsonResponse { status, body }
}
