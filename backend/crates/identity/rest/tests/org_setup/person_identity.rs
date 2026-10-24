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
    sqlx::query("DELETE FROM employee_person_bindings WHERE employee_id=$1")
        .bind(approver_employee)
        .execute(&pool)
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
    sqlx::query("DELETE FROM employee_person_bindings WHERE employee_id=ANY($1)")
        .bind(vec![own, target_employee])
        .execute(&pool)
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

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unbound_requester_or_checker_cannot_approve_link_changes(pool: PgPool) {
    let (h, actor, target, employee) = fixture(&pool).await;
    let approver = aged_noticed_approver(&pool).await;
    let (_, body) = request_unlink(&h, actor, target, None).await;
    let request = body["account_link"]["request_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    for user in [actor, approver] {
        let mut identity = pool.begin().await.unwrap();
        sqlx::query("UPDATE users SET is_tenant_ops=false,person_id=COALESCE(public.console_employee_person(org_id,employee_id),id) WHERE id=ANY($1)")
            .bind(vec![*actor.as_uuid(),*approver.as_uuid()]).execute(identity.as_mut()).await.unwrap();
        sqlx::query("UPDATE users SET is_tenant_ops=true WHERE id=$1")
            .bind(user.as_uuid())
            .execute(identity.as_mut())
            .await
            .unwrap();
        identity.commit().await.unwrap();
        let (status, body) = request_unlink(&h, approver, target, Some(request)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(
            body["error"]["code"],
            "account_link.refuse.identity_unbound"
        );
        assert_eq!(employee_link(&pool, target).await, Some(employee));
    }
}
