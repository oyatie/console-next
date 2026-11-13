// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

const WITHDRAW: &str = "/api/v1/users/me/employee-link/withdraw";

async fn post(h: &Harness, path: &str, token: &str, body: Value) -> (StatusCode, Value) {
    let request = Request::builder()
        .method("POST")
        .uri(path)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "application/json")
        .header("Idempotency-Key", Uuid::new_v4().to_string())
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = h.service().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes))),
    )
}

async fn rename(pool: &PgPool, employee: Uuid, name: &str) {
    sqlx::query("UPDATE employees SET name=$2 WHERE id=$1")
        .bind(employee)
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
}

async fn fresh_token(pool: &PgPool, h: &Harness, actor: UserId) -> String {
    let mut input = h.access_token_input(actor, &[], vec![]);
    let (version, generation): (i64, i64) = sqlx::query_as("SELECT version,session_generation FROM subject_authz_versions WHERE org_id=$1 AND user_id=$2")
        .bind(OrgId::one().as_uuid()).bind(actor.as_uuid()).fetch_optional(pool).await.unwrap().unwrap_or((0,0));
    input.authz_subject_version = version.try_into().unwrap();
    input.session_generation = generation.try_into().unwrap();
    console_platform_test_support::issue_session_token(&h.pool, &h.issuer(), input, None, vec![])
        .await
}

async fn withdraw(pool: &PgPool, h: &Harness, actor: UserId, receipt: Uuid) -> (StatusCode, Value) {
    let token = fresh_token(pool, h, actor).await;
    let mut key = SoftKey::enroll(&h.pool, OrgId::one(), actor).await;
    post(
        h,
        WITHDRAW,
        &token,
        json!({"attestation_id":receipt,"step_up":key.step_up(&h.pool).await}),
    )
    .await
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn refuses_a_different_record_in_offer_and_command(pool: PgPool) {
    let (h, actor, employee, token) = fixture(&pool).await;
    let step_up = proof(&h, actor, employee, &token).await;
    rename(&pool, employee, "Another employee").await;
    for (path, body) in [
        (PREPARE, json!({"employee_id":employee})),
        (COMMAND, json!({"employee_id":employee,"step_up":step_up})),
    ] {
        let (status, body) = post(&h, path, &token, body).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(body["error"]["code"], "account_link.refuse.not_own_record");
    }
    unchanged(&pool, actor).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn no_match_requires_the_full_record_name_bound_to_the_proof(pool: PgPool) {
    let (h, actor, employee, token) = fixture(&pool).await;
    rename(&pool, employee, "Full employee name").await;
    for name in [None, Some("Full"), Some("")] {
        let (status, body) = post(
            &h,
            PREPARE,
            &token,
            json!({"employee_id":employee,"confirmed_name":name}),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(body["error"]["code"], "account_link.refuse.not_own_record");
    }
    let (status, binding) = post(
        &h,
        PREPARE,
        &token,
        json!({"employee_id":employee,"confirmed_name":"Full employee name"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{binding}");
    let mut key = SoftKey::enroll(&h.pool, OrgId::one(), actor).await;
    let start = passkey_service()
        .start_mobile_step_up(
            &h.pool,
            *actor.as_uuid(),
            serde_json::from_value(binding.clone()).unwrap(),
        )
        .await
        .unwrap();
    let mut challenge = serde_json::to_value(start.challenge).unwrap();
    challenge["publicKey"]["allowCredentials"] =
        json!([{"type":"public-key","id":key.credential_id()}]);
    let step_up = json!({"binding":binding,"assertion":{"ceremony_id":start.ceremony_id,"credential":key.assert(&challenge).unwrap()}});
    let (status, body) = post(
        &h,
        COMMAND,
        &token,
        json!({"employee_id":employee,"step_up":step_up}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "step_up_failed");
    let (status, body) = post(
        &h,
        COMMAND,
        &token,
        json!({"employee_id":employee,"confirmed_name":"Full employee name","step_up":step_up}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn confirmation_cannot_override_an_existing_matching_record(pool: PgPool) {
    let (h, actor, employee, token) = fixture(&pool).await;
    let other: Uuid = sqlx::query_scalar("INSERT INTO employees(org_id,company,name,source_filename,source_sheet,source_row,source_key) VALUES($1,'Synthetic','Other employee','fixture','fixture',2,gen_random_uuid()::text) RETURNING id")
        .bind(OrgId::one().as_uuid()).fetch_one(&pool).await.unwrap();
    let (status, body) = post(
        &h,
        PREPARE,
        &token,
        json!({"employee_id":other,"confirmed_name":"Other employee"}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "account_link.refuse.not_own_record");
    let (status, _) = post(&h, PREPARE, &token, json!({"employee_id":employee})).await;
    assert_eq!(status, StatusCode::OK);
    unchanged(&pool, actor).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn self_attester_can_withdraw_once_and_correct_the_binding(pool: PgPool) {
    let (h, actor, employee, token) = fixture(&pool).await;
    let step_up = proof(&h, actor, employee, &token).await;
    let (status, body) = post(
        &h,
        COMMAND,
        &token,
        json!({"employee_id":employee,"step_up":step_up}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let receipt = serde_json::from_value(body["attestation_id"].clone()).unwrap();
    let (status, body) = withdraw(&pool, &h, actor, receipt).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let linked: Option<Uuid> = sqlx::query_scalar("SELECT employee_id FROM users WHERE id=$1")
        .bind(actor.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(linked, None);
    let person: Option<Uuid> = sqlx::query_scalar("SELECT person_id FROM users WHERE id=$1")
        .bind(actor.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        person,
        Some(*actor.as_uuid()),
        "withdrawal must restore the account identity"
    );
    let (status, body) = withdraw(&pool, &h, actor, receipt).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "account_link.refuse.review_stale");
    let audits: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE action='account_link.withdrawn' AND actor=$1 AND after_snap->>'self_attestation_id'=$2")
        .bind(actor.as_uuid()).bind(receipt.to_string()).fetch_one(&pool).await.unwrap();
    assert_eq!(audits, 1);
    let token = fresh_token(&pool, &h, actor).await;
    let step_up = proof(&h, actor, employee, &token).await;
    let (status, body) = post(
        &h,
        COMMAND,
        &token,
        json!({"employee_id":employee,"step_up":step_up}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn cannot_withdraw_another_accounts_attestation(pool: PgPool) {
    let (h, actor, employee, token) = fixture(&pool).await;
    let step_up = proof(&h, actor, employee, &token).await;
    let (_, body) = post(
        &h,
        COMMAND,
        &token,
        json!({"employee_id":employee,"step_up":step_up}),
    )
    .await;
    let receipt = serde_json::from_value(body["attestation_id"].clone()).unwrap();
    let other = seed_user(&pool, "Other account", &[], None).await;
    let (status, body) = withdraw(&pool, &h, other, receipt).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(
        body["error"]["code"],
        "account_link.refuse.withdraw_ineligible"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn withdrawal_requires_step_up(pool: PgPool) {
    let (h, _, _, token) = fixture(&pool).await;
    let (status, body) = post(
        &h,
        WITHDRAW,
        &token,
        json!({"attestation_id":Uuid::new_v4()}),
    )
    .await;
    assert_eq!(status, StatusCode::PRECONDITION_REQUIRED, "{body}");
    assert_eq!(body["error"]["code"], "passkey_step_up_required");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn reviewed_self_attestation_cannot_be_withdrawn(pool: PgPool) {
    let (h, actor, employee, token) = fixture(&pool).await;
    let step_up = proof(&h, actor, employee, &token).await;
    let (_, body) = post(
        &h,
        COMMAND,
        &token,
        json!({"employee_id":employee,"step_up":step_up}),
    )
    .await;
    let receipt = serde_json::from_value(body["attestation_id"].clone()).unwrap();
    let other = seed_user(&pool, "Reviewer", &[], None).await;
    sqlx::query("INSERT INTO account_link_self_reviews(org_id,attestation_id,decision,reviewer_id,reviewed_at) VALUES($1,$2,'CONFIRM',$3,now())")
        .bind(OrgId::one().as_uuid()).bind(receipt).bind(other.as_uuid()).execute(&pool).await.unwrap();
    let (status, body) = withdraw(&pool, &h, actor, receipt).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "account_link.refuse.review_stale");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn withdrawal_audit_failure_rolls_back_identity_and_decision(pool: PgPool) {
    let (h, actor, employee, token) = fixture(&pool).await;
    let step_up = proof(&h, actor, employee, &token).await;
    let (_, body) = post(
        &h,
        COMMAND,
        &token,
        json!({"employee_id":employee,"step_up":step_up}),
    )
    .await;
    let receipt = serde_json::from_value(body["attestation_id"].clone()).unwrap();
    sqlx::raw_sql("CREATE FUNCTION refuse_withdrawal_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='account_link.withdrawn' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER refuse_withdrawal_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION refuse_withdrawal_audit();")
        .execute(&pool).await.unwrap();
    let (status, _) = withdraw(&pool, &h, actor, receipt).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    let (linked, reviewed): (Option<Uuid>, bool) = sqlx::query_as("SELECT employee_id,EXISTS(SELECT 1 FROM account_link_self_reviews WHERE attestation_id=$2) FROM users WHERE id=$1")
        .bind(actor.as_uuid()).bind(receipt).fetch_one(&pool).await.unwrap();
    assert_eq!((linked, reviewed), (Some(employee), false));
    sqlx::query("DROP TRIGGER refuse_withdrawal_audit ON audit_events")
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = withdraw(&pool, &h, actor, receipt).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}
