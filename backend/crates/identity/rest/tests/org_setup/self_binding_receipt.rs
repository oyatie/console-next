// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

async fn receipt(h: &Harness, token: &str) -> (StatusCode, Value) {
    send(h, "GET", COMMAND, token, None).await
}

async fn attest(pool: &PgPool, actor: UserId, employee: Uuid) -> Uuid {
    let h = Harness::new(pool.clone()).await;
    let token = h.token(actor, &[], vec![]).await;
    let step_up = proof(&h, actor, employee, &token).await;
    let (status, body) = post(
        &h,
        COMMAND,
        &token,
        json!({"employee_id":employee,"step_up":step_up}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    serde_json::from_value(body["attestation_id"].clone()).unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn receipt_tracks_current_binding_and_cedar_withdrawal_permission(pool: PgPool) {
    let (h, actor, employee, token) = fixture(&pool).await;
    assert_eq!(
        receipt(&h, &token).await,
        (StatusCode::OK, json!({"attestation":null}))
    );
    let id = attest(&pool, actor, employee).await;
    let token = safeguards::fresh_token(&pool, &h, actor).await;
    let expected =
        json!({"attestation":{"attestation_id":id,"employee_id":employee,"can_withdraw":true}});
    assert_eq!(
        receipt(&h, &token).await,
        (StatusCode::OK, expected.clone())
    );
    let reviewer = seed_user(&pool, "Reviewer", &[], None).await;
    sqlx::query("INSERT INTO account_link_self_reviews(org_id,attestation_id,decision,reviewer_id,reviewed_at) VALUES($1,$2,'CONFIRM',$3,now())")
        .bind(OrgId::one().as_uuid()).bind(id).bind(reviewer.as_uuid()).execute(&pool).await.unwrap();
    let mut confirmed = expected;
    confirmed["attestation"]["can_withdraw"] = json!(false);
    assert_eq!(receipt(&h, &token).await, (StatusCode::OK, confirmed));
    sqlx::query("INSERT INTO account_link_self_reviews(org_id,attestation_id,decision,reviewer_id,reviewed_at) VALUES($1,$2,'REVOKE',$3,now())")
        .bind(OrgId::one().as_uuid()).bind(id).bind(reviewer.as_uuid()).execute(&pool).await.unwrap();
    assert_eq!(
        receipt(&h, &token).await,
        (StatusCode::OK, json!({"attestation":null}))
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn receipt_excludes_other_accounts_tenants_and_replacement_bindings(pool: PgPool) {
    let (h, actor, employee, _token) = fixture(&pool).await;
    attest(&pool, actor, employee).await;
    let token = safeguards::fresh_token(&pool, &h, actor).await;
    let other = seed_user(&pool, "Other account", &[], None).await;
    let other_token = h.token(other, &[], vec![]).await;
    assert_eq!(
        receipt(&h, &other_token).await,
        (StatusCode::OK, json!({"attestation":null}))
    );
    let foreign = OrgId::new();
    seed_org(&pool, foreign, "foreign-receipt").await;
    let foreign_actor =
        seed_user_in_org_with_team(&pool, foreign, "Foreign account", &[], None, None).await;
    let foreign_token = h.token_for_org(foreign, foreign_actor, &[], vec![]).await;
    assert_eq!(
        receipt(&h, &foreign_token).await,
        (StatusCode::OK, json!({"attestation":null}))
    );
    sqlx::query("UPDATE users SET employee_id=NULL WHERE id=$1")
        .bind(actor.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        receipt(&h, &token).await,
        (StatusCode::OK, json!({"attestation":null}))
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn receipt_requires_authentication(pool: PgPool) {
    let (h, _, _, _) = fixture(&pool).await;
    let (status, body) = receipt(&h, "invalid").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["code"], "unauthorized");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn receipt_refuses_an_inactive_account(pool: PgPool) {
    let (h, _, _, _) = fixture(&pool).await;
    let actor = seed_user(&pool, "Inactive account", &[], None).await;
    let token = h.token(actor, &[], vec![]).await;
    sqlx::query("UPDATE users SET is_active=false WHERE id=$1")
        .bind(actor.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = receipt(&h, &token).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["code"], "unauthorized");
}
