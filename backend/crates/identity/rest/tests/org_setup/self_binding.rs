// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_platform_test_support::soft_passkey::SoftKey;
use uuid::Uuid;
#[path = "../../../adapter-postgres/tests/second_person_support/mod.rs"]
mod holders;

const PREPARE: &str = "/api/v1/users/me/employee-link/prepare";
const COMMAND: &str = "/api/v1/users/me/employee-link";

async fn fixture(pool: &PgPool) -> (Harness, UserId, Uuid, String) {
    let h = Harness::new(pool.clone()).await;
    let actor = seed_user(pool, "Operator", &[], None).await;
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE id=$1")
        .bind(actor.as_uuid())
        .execute(pool)
        .await
        .unwrap();
    let employee: Uuid = sqlx::query_scalar("INSERT INTO employees(org_id,company,name,source_filename,source_sheet,source_row,source_key) \
        VALUES($1,'Synthetic','Operator','fixture','fixture',1,gen_random_uuid()::text) RETURNING id")
        .bind(OrgId::one().as_uuid()).fetch_one(pool).await.unwrap();
    let token = h.token(actor, &[], vec![]).await;
    (h, actor, employee, token)
}

async fn post(h: &Harness, path: &str, token: &str, body: Value) -> (StatusCode, Value) {
    send(h, "POST", path, token, Some(body)).await
}

async fn proof(h: &Harness, actor: UserId, employee: Uuid, token: &str) -> Value {
    let mut key = SoftKey::enroll(&h.pool, OrgId::one(), actor).await;
    let (status, prepared) = post(h, PREPARE, token, json!({"employee_id":employee})).await;
    assert_eq!(status, StatusCode::OK, "{prepared}");
    let binding = serde_json::from_value(prepared.clone()).unwrap();
    let mut ceremony = passkey_service()
        .start_mobile_step_up(&h.pool, *actor.as_uuid(), binding)
        .await
        .unwrap();
    PasskeyService::name_own_credentials(&h.pool, OrgId::one(), *actor.as_uuid(), &mut ceremony)
        .await
        .unwrap();
    let assertion = key
        .assert(&serde_json::to_value(ceremony.challenge).unwrap())
        .unwrap();
    json!({"binding":prepared,"assertion":{"ceremony_id":ceremony.ceremony_id,"credential":assertion}})
}

async fn unchanged(pool: &PgPool, actor: UserId) {
    let (linked, receipts, audits): (Option<Uuid>, i64, i64) = sqlx::query_as("SELECT employee_id, \
        (SELECT count(*) FROM account_link_self_attestations WHERE account_id=$1), \
        (SELECT count(*) FROM audit_events WHERE actor=$1 AND action='account_link.self_attested') FROM users WHERE id=$1")
        .bind(actor.as_uuid()).fetch_one(pool).await.unwrap();
    assert_eq!((linked, receipts, audits), (None, 0, 0));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn http_self_binding_commits_once_and_refuses_replayed_step_up(pool: PgPool) {
    let (h, actor, employee, token) = fixture(&pool).await;
    let step_up = proof(&h, actor, employee, &token).await;
    let command = json!({"employee_id":employee,"step_up":step_up});
    let (status, body) = post(&h, COMMAND, &token, command.clone()).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let receipt: Uuid = serde_json::from_value(body["attestation_id"].clone()).unwrap();
    let (linked, receipts, audits): (Option<Uuid>, i64, i64) = sqlx::query_as("SELECT employee_id, \
        (SELECT count(*) FROM account_link_self_attestations WHERE id=$2 AND account_id=$1), \
        (SELECT count(*) FROM audit_events WHERE actor=$1 AND action='account_link.self_attested') FROM users WHERE id=$1")
        .bind(actor.as_uuid()).bind(receipt).fetch_one(&pool).await.unwrap();
    assert_eq!((linked, receipts, audits), (Some(employee), 1, 1));
    // A new session observes the binding's authorization version bump.
    let mut input = h.access_token_input(actor, &[], vec![]);
    let (version, generation): (i64, i64) = sqlx::query_as("SELECT version,session_generation FROM subject_authz_versions WHERE org_id=$1 AND user_id=$2")
        .bind(OrgId::one().as_uuid()).bind(actor.as_uuid()).fetch_one(&pool).await.unwrap();
    input.authz_subject_version = version.try_into().unwrap();
    input.session_generation = generation.try_into().unwrap();
    let token = console_platform_test_support::issue_session_token(
        &h.pool,
        &h.issuer(),
        input,
        None,
        vec![],
    )
    .await;
    let (status, body) = post(&h, COMMAND, &token, command).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "step_up_failed");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn http_self_binding_requires_step_up(pool: PgPool) {
    let (h, actor, employee, token) = fixture(&pool).await;
    let (status, body) = post(&h, COMMAND, &token, json!({"employee_id":employee})).await;
    assert_eq!(status, StatusCode::PRECONDITION_REQUIRED, "{body}");
    assert_eq!(body["error"]["code"], "step_up_required");
    unchanged(&pool, actor).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn http_self_binding_rechecks_a_second_operator_after_preparation(pool: PgPool) {
    let (h, actor, employee, token) = fixture(&pool).await;
    let step_up = proof(&h, actor, employee, &token).await;
    let other = seed_user(&pool, "Second operator", &[], None).await;
    holders::access::grant(
        &pool,
        *OrgId::one().as_uuid(),
        *actor.as_uuid(),
        *other.as_uuid(),
        holders::access::Grant {
            domain: "access",
            level: "edit",
            age_days: 0,
            notified: false,
            ..holders::access::CLOSE
        },
    )
    .await;
    holders::access::go_live(&pool, *OrgId::one().as_uuid(), *actor.as_uuid()).await;
    let (status, body) = post(
        &h,
        COMMAND,
        &token,
        json!({"employee_id":employee,"step_up":step_up}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "account_link.refuse.solo_ineligible");
    let (status, body) = post(&h, PREPARE, &token, json!({"employee_id":employee})).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "account_link.refuse.solo_ineligible");
    unchanged(&pool, actor).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn http_self_binding_refuses_an_employee_taken_after_preparation(pool: PgPool) {
    let (h, actor, employee, token) = fixture(&pool).await;
    let step_up = proof(&h, actor, employee, &token).await;
    let other = seed_user(&pool, "Other account", &[], None).await;
    sqlx::query("UPDATE users SET employee_id=$2 WHERE id=$1")
        .bind(other.as_uuid())
        .bind(employee)
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = post(
        &h,
        COMMAND,
        &token,
        json!({"employee_id":employee,"step_up":step_up}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "account_link.refuse.employee_taken");
    let (status, body) = post(&h, PREPARE, &token, json!({"employee_id":employee})).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "account_link.refuse.employee_taken");
    unchanged(&pool, actor).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn http_self_binding_refuses_a_proof_for_another_employee(pool: PgPool) {
    let (h, actor, employee, token) = fixture(&pool).await;
    let step_up = proof(&h, actor, employee, &token).await;
    let (status, body) = post(
        &h,
        COMMAND,
        &token,
        json!({"employee_id":Uuid::new_v4(),"step_up":step_up}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "step_up_failed");
    unchanged(&pool, actor).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn http_self_binding_missing_employee_is_not_found(pool: PgPool) {
    let (h, actor, _, token) = fixture(&pool).await;
    let missing = Uuid::new_v4();
    let (status, body) = post(&h, PREPARE, &token, json!({"employee_id":missing})).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["error"]["code"], "not_found");
    unchanged(&pool, actor).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn http_self_binding_cannot_select_another_account(pool: PgPool) {
    let (h, actor, employee, token) = fixture(&pool).await;
    for path in [PREPARE, COMMAND] {
        let request = Request::builder()
            .method("POST")
            .uri(path)
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({"employee_id":employee,"account_id":Uuid::new_v4()}).to_string(),
            ))
            .unwrap();
        let response = h.service().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }
    unchanged(&pool, actor).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn http_self_binding_requires_an_authenticated_account(pool: PgPool) {
    let (h, actor, employee, token) = fixture(&pool).await;
    for path in [PREPARE, COMMAND] {
        let (status, body) = post(&h, path, "invalid", json!({"employee_id":employee})).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    }
    SoftKey::enroll(&h.pool, OrgId::one(), actor).await;
    let (status, body) = post(&h, PREPARE, &token, json!({"employee_id":employee})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}
