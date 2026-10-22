// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[path = "../../../../../test-support/person_fixtures.rs"]
mod people;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unlinked_target_can_be_linked_by_two_distinct_people(pool: PgPool) {
    let (h, actor, target, employee) = fixture(&pool).await;
    people::bind_user_to_distinct_person(&pool, actor).await;
    let approver = aged_noticed_approver(&pool).await;
    let approver_employee = employee_link(&pool, approver).await.unwrap();
    let person: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO persons (org_id) VALUES ($1) RETURNING id")
            .bind(OrgId::one().as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
    sqlx::query("INSERT INTO employee_person_bindings (org_id,employee_id,person_id,actor_id,payload_digest) VALUES ($1,$2,$3,$4,$5)")
        .bind(OrgId::one().as_uuid()).bind(approver_employee).bind(person).bind(approver.as_uuid()).bind(vec![0_u8;32]).execute(&pool).await.unwrap();
    sqlx::query("UPDATE users SET employee_id=NULL WHERE id=$1")
        .bind(target.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let token = h.token(actor, &["SUPER_ADMIN"], vec![]).await;
    let step_up = fresh_step_up_assertion(&h.pool, actor, "Requester").await;
    let (status, body) = send_patch(
        &h,
        &format!("/api/v1/users/{target}"),
        &token,
        json!({"employee_id": employee, "step_up": step_up}),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    let id = body["account_link"]["request_id"].clone();
    let notices: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM notifications WHERE recipient_user_id=$1 AND category='account_link'",
    )
    .bind(approver.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(notices, 1);
    let token = h.token(approver, &["SUPER_ADMIN"], vec![]).await;
    let step_up = fresh_step_up_assertion(&h.pool, approver, "Approver").await;
    let (status, body) = send_patch(
        &h,
        &format!("/api/v1/users/{target}"),
        &token,
        json!({"employee_id": employee, "step_up": step_up, "account_link_request_id": id}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(employee_link(&pool, target).await, Some(employee));
}

const REVIEW: &str = "/api/v1/users?independence_review_required=true&include_inactive=true";

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn fallback_decisions_have_immutable_evidence_and_scoped_actionable_reviews(pool: PgPool) {
    let (h, actor, target, _) = fixture(&pool).await;
    let approver = aged_noticed_approver(&pool).await;
    let token = h.token(actor, &["SUPER_ADMIN"], vec![]).await;
    let (status, before) = send(&h, "GET", REVIEW, &token, None).await;
    assert_eq!(status, StatusCode::OK, "{before}");
    assert_eq!(
        before["total"], 0,
        "probes and ordinary accounts are not review items"
    );
    let (status, requested) = request_unlink(&h, actor, target, None).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{requested}");
    let (_, pending) = send(&h, "GET", REVIEW, &token, None).await;
    assert_eq!(
        pending["total"], 0,
        "an undecided proposal creates no review item"
    );
    let request = requested["account_link"]["request_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let (status, approved) = request_unlink(&h, approver, target, Some(request)).await;
    assert_eq!(status, StatusCode::OK, "{approved}");
    let evidence: (Value, Value) = sqlx::query_as("SELECT decision_snapshot,after_snap FROM audit_events WHERE action='account_link.approved' AND target_id=$1")
        .bind(target.to_string()).fetch_one(&pool).await.unwrap();
    assert_eq!(evidence.0["sod.maker.account"], actor.to_string());
    assert_eq!(evidence.0["sod.checker.account"], approver.to_string());
    assert_eq!(evidence.1["independence"]["review_required"], true);
    let (_, page) = send(&h, "GET", &format!("{REVIEW}&limit=1"), &token, None).await;
    let (_, next) = send(
        &h,
        "GET",
        &format!("{REVIEW}&limit=1&offset=1"),
        &token,
        None,
    )
    .await;
    assert_eq!(page["total"], 2);
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_ne!(page["items"][0]["id"], next["items"][0]["id"]);
    let lower = seed_user(&pool, "Reader", &["MECHANIC"], None).await;
    let lower = h.token(lower, &["MECHANIC"], vec![]).await;
    assert_eq!(
        send(&h, "GET", REVIEW, &lower, None).await.0,
        StatusCode::FORBIDDEN
    );
    let foreign_org = uuid::Uuid::new_v4();
    let foreign = console_platform_test_support::seed_org_and_super_admin(
        &pool,
        foreign_org,
        "foreign-review",
    )
    .await;
    let foreign = h
        .token_for_org(
            OrgId::from_uuid(foreign_org),
            foreign,
            &["SUPER_ADMIN"],
            vec![],
        )
        .await;
    let (status, page) = send(&h, "GET", REVIEW, &foreign, None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["total"], 0);
    people::bind_user_to_distinct_person(&pool, actor).await;
    let (_, page) = send(&h, "GET", REVIEW, &token, None).await;
    assert_eq!(
        page["total"], 1,
        "only the account still needing a person link remains"
    );
    assert_eq!(page["items"][0]["id"], approver.to_string());
    let after: (Value, Value) = sqlx::query_as("SELECT decision_snapshot,after_snap FROM audit_events WHERE action='account_link.approved' AND target_id=$1")
        .bind(target.to_string()).fetch_one(&pool).await.unwrap();
    assert_eq!(
        after, evidence,
        "a later person link must never rewrite decision evidence"
    );
    sqlx::query("UPDATE users SET is_active=false WHERE id=$1")
        .bind(approver.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let (_, page) = send(&h, "GET", REVIEW, &token, None).await;
    assert_eq!(
        page["total"], 1,
        "deactivation must not hide an outstanding review"
    );
    assert_eq!(page["items"][0]["is_active"], false);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn own_account_includes_shared_employee_and_shared_person(pool: PgPool) {
    let (h, actor, target, target_employee) = fixture(&pool).await;
    let own = seed_employee_link(&pool, actor, "K1-SELF", "Requester").await;
    // Mutation control: the self check must hold even without the unique-link backstop.
    sqlx::query("DROP INDEX users_org_employee_unique_idx")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET employee_id=$1 WHERE id=$2")
        .bind(own)
        .bind(target.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = request_unlink(&h, actor, target, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "account_link_self_forbidden");
    sqlx::query("UPDATE users SET employee_id=$1 WHERE id=$2")
        .bind(target_employee)
        .bind(target.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let person: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO persons (org_id) VALUES ($1) RETURNING id")
            .bind(OrgId::one().as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
    sqlx::query("INSERT INTO employee_person_bindings (org_id,employee_id,person_id,actor_id,payload_digest) SELECT $1,employee,$2,$3,$4 FROM unnest($5::uuid[]) employee")
        .bind(OrgId::one().as_uuid()).bind(person).bind(actor.as_uuid()).bind(vec![0_u8;32]).bind(vec![own,target_employee]).execute(&pool).await.unwrap();
    let (status, body) = request_unlink(&h, actor, target, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "account_link_self_forbidden");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn self_identity_evaluation_errors_keep_the_refusal_code(pool: PgPool) {
    let (h, actor, target, employee) = fixture(&pool).await;
    sqlx::query(
        "REVOKE EXECUTE ON FUNCTION public.console_decision_people(UUID,UUID,UUID) FROM console_rt",
    )
    .execute(&pool)
    .await
    .unwrap();
    let (status, body) = request_unlink(&h, actor, target, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "account_link_self_forbidden");
    assert_eq!(employee_link(&pool, target).await, Some(employee));
}
