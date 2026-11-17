// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

fn route(receipt: Uuid) -> String {
    format!("/api/v1/users/employee-link-attestations/{receipt}/review")
}

async fn attested(pool: &PgPool) -> (Harness, UserId, Uuid, Uuid) {
    let (h, actor, employee, token) = fixture(pool).await;
    sqlx::query("UPDATE employees SET identity_review_required=false WHERE id=$1")
        .bind(employee)
        .execute(pool)
        .await
        .unwrap();
    let step_up = proof(&h, actor, employee, &token).await;
    let (status, body) = post(
        &h,
        COMMAND,
        &token,
        json!({"employee_id":employee,"step_up":step_up}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    (
        h,
        actor,
        employee,
        serde_json::from_value(body["attestation_id"].clone()).unwrap(),
    )
}

async fn reviewer(pool: &PgPool, actor: UserId, bound: bool, permitted: bool) -> UserId {
    let reviewer = seed_user(pool, "Independent reviewer", &[], None).await;
    if bound {
        seed_employee_link(pool, reviewer, "REVIEWER", "Independent reviewer").await;
    }
    if permitted {
        holders::access::grant(
            pool,
            *OrgId::one().as_uuid(),
            *actor.as_uuid(),
            *reviewer.as_uuid(),
            holders::access::Grant {
                domain: "access",
                level: "edit",
                ..holders::access::CLOSE
            },
        )
        .await;
    }
    holders::access::go_live(pool, *OrgId::one().as_uuid(), *actor.as_uuid()).await;
    reviewer
}

async fn assertion(h: &Harness, actor: UserId) -> Value {
    SoftKey::enroll(&h.pool, OrgId::one(), actor)
        .await
        .step_up(&h.pool)
        .await
}

async fn decide(
    pool: &PgPool,
    h: &Harness,
    actor: UserId,
    receipt: Uuid,
    decision: &str,
) -> (StatusCode, Value) {
    let token = safeguards::fresh_token(pool, h, actor).await;
    post(
        h,
        &route(receipt),
        &token,
        json!({"decision":decision,"step_up":assertion(h, actor).await}),
    )
    .await
}

async fn evidence(pool: &PgPool, actor: UserId, receipt: Uuid) -> (Option<Uuid>, i64, i64) {
    sqlx::query_as("SELECT employee_id, \
        (SELECT count(*) FROM account_link_self_reviews WHERE attestation_id=$2), \
        (SELECT count(*) FROM audit_events WHERE after_snap->>'self_attestation_id'=$2::text AND action IN ('account_link.confirmed','account_link.revoked')) \
        FROM users WHERE id=$1")
        .bind(actor.as_uuid()).bind(receipt).fetch_one(pool).await.unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn http_reviewer_confirms_then_revokes_once_with_audited_identity(pool: PgPool) {
    let (h, actor, employee, receipt) = attested(&pool).await;
    let checker = reviewer(&pool, actor, true, true).await;
    for (decision, expected, count) in [("CONFIRM", Some(employee), 1), ("REVOKE", None, 2)] {
        let (status, body) = decide(&pool, &h, checker, receipt, decision).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body, json!({}));
        assert_eq!(
            evidence(&pool, actor, receipt).await,
            (expected, count, count)
        );
        let (status, body) = decide(&pool, &h, checker, receipt, decision).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["error"]["code"], "account_link.refuse.review_stale");
        assert_eq!(
            evidence(&pool, actor, receipt).await,
            (expected, count, count)
        );
    }
    let person: Option<Uuid> = sqlx::query_scalar("SELECT person_id FROM users WHERE id=$1")
        .bind(actor.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(person, Some(*actor.as_uuid()));
    let actors: Vec<Uuid> = sqlx::query_scalar("SELECT actor FROM audit_events WHERE after_snap->>'self_attestation_id'=$1::text AND action IN ('account_link.confirmed','account_link.revoked')")
        .bind(receipt).fetch_all(&pool).await.unwrap();
    assert_eq!(actors, vec![*checker.as_uuid(); 2]);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn http_review_requires_a_fresh_nonreplayable_own_passkey(pool: PgPool) {
    let (h, actor, employee, receipt) = attested(&pool).await;
    let checker = reviewer(&pool, actor, true, true).await;
    let token = safeguards::fresh_token(&pool, &h, checker).await;
    let (status, body) = post(&h, &route(receipt), &token, json!({"decision":"CONFIRM"})).await;
    assert_eq!(status, StatusCode::PRECONDITION_REQUIRED, "{body}");
    assert_eq!(body["error"]["code"], "passkey_step_up_required");
    let step_up = assertion(&h, actor).await;
    let (status, body) = post(
        &h,
        &route(receipt),
        &token,
        json!({"decision":"CONFIRM","step_up":step_up}),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["code"], "unauthorized");
    assert_eq!(
        evidence(&pool, actor, receipt).await,
        (Some(employee), 0, 0)
    );
    let step_up = assertion(&h, checker).await;
    let (status, body) = post(
        &h,
        &route(receipt),
        &token,
        json!({"decision":"CONFIRM","step_up":step_up}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = post(
        &h,
        &route(receipt),
        &token,
        json!({"decision":"REVOKE","step_up":step_up}),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["code"], "unauthorized");
    assert_eq!(
        evidence(&pool, actor, receipt).await,
        (Some(employee), 1, 1)
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn http_review_refuses_self_review_and_missing_permission(pool: PgPool) {
    let (h, actor, employee, receipt) = attested(&pool).await;
    let outsider = reviewer(&pool, actor, true, false).await;
    for checker in [actor, outsider] {
        let (status, body) = decide(&pool, &h, checker, receipt, "CONFIRM").await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(
            body["error"]["code"],
            "account_link.refuse.review_ineligible"
        );
    }
    assert_eq!(
        evidence(&pool, actor, receipt).await,
        (Some(employee), 0, 0)
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn http_review_refuses_an_unbound_reviewer(pool: PgPool) {
    let (h, actor, employee, receipt) = attested(&pool).await;
    let checker = reviewer(&pool, actor, false, true).await;
    let (status, body) = decide(&pool, &h, checker, receipt, "REVOKE").await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(
        body["error"]["code"],
        "account_link.refuse.identity_unbound"
    );
    assert_eq!(
        evidence(&pool, actor, receipt).await,
        (Some(employee), 0, 0)
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn http_review_reloads_permission_after_step_up(pool: PgPool) {
    let (h, actor, employee, receipt) = attested(&pool).await;
    let checker = reviewer(&pool, actor, true, true).await;
    let token = safeguards::fresh_token(&pool, &h, checker).await;
    let step_up = assertion(&h, checker).await;
    sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=$1 WHERE account_id=$2")
        .bind(actor.as_uuid()).bind(checker.as_uuid()).execute(&pool).await.unwrap();
    let (status, body) = post(
        &h,
        &route(receipt),
        &token,
        json!({"decision":"REVOKE","step_up":step_up}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(
        body["error"]["code"],
        "account_link.refuse.review_ineligible"
    );
    assert_eq!(
        evidence(&pool, actor, receipt).await,
        (Some(employee), 0, 0)
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn http_review_never_changes_a_replacement_binding(pool: PgPool) {
    let (h, actor, _, receipt) = attested(&pool).await;
    let checker = reviewer(&pool, actor, true, true).await;
    let replacement = seed_employee_link(&pool, actor, "REPLACEMENT", "Replacement").await;
    let (status, body) = decide(&pool, &h, checker, receipt, "REVOKE").await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "account_link.refuse.review_stale");
    assert_eq!(
        evidence(&pool, actor, receipt).await,
        (Some(replacement), 0, 0)
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn http_review_does_not_expose_missing_or_foreign_receipts(pool: PgPool) {
    let (h, actor, employee, receipt) = attested(&pool).await;
    let checker = reviewer(&pool, actor, true, true).await;
    let other_org = OrgId::new();
    seed_org(&pool, other_org, "foreign-review").await;
    let foreign_actor =
        seed_user_in_org_with_team(&pool, other_org, "Foreign operator", &[], None, None).await;
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE id=$1")
        .bind(foreign_actor.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let foreign_token = h.token_for_org(other_org, foreign_actor, &[], vec![]).await;
    let mut key = SoftKey::enroll(&h.pool, other_org, foreign_actor).await;
    let (status, body) = post(
        &h,
        &route(receipt),
        &foreign_token,
        json!({"decision":"CONFIRM","step_up":key.step_up(&h.pool).await}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["error"]["code"], "not_found");
    let (status, body) = decide(&pool, &h, checker, Uuid::new_v4(), "CONFIRM").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["error"]["code"], "not_found");
    assert_eq!(
        evidence(&pool, actor, receipt).await,
        (Some(employee), 0, 0)
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn http_review_rejects_withdraw_actor_spoofing_and_unauthenticated_commands(pool: PgPool) {
    let (h, actor, employee, receipt) = attested(&pool).await;
    let checker = reviewer(&pool, actor, true, true).await;
    let token = safeguards::fresh_token(&pool, &h, checker).await;
    for body in [
        json!({"decision":"WITHDRAW"}),
        json!({"decision":"CONFIRM","actor_id":actor}),
    ] {
        let request = Request::builder()
            .method("POST")
            .uri(route(receipt))
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::CONTENT_TYPE, "application/json")
            .header("Idempotency-Key", Uuid::new_v4().to_string())
            .body(Body::from(body.to_string()))
            .unwrap();
        let response = h.service().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }
    let (status, body) = post(
        &h,
        &route(receipt),
        "invalid",
        json!({"decision":"CONFIRM"}),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(
        evidence(&pool, actor, receipt).await,
        (Some(employee), 0, 0)
    );
}
