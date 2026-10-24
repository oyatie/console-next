// SPDX-License-Identifier: LicenseRef-Proprietary
//! K1: a link change waits for an independent, eligible approver bound to the stored request.
use super::*;

async fn aged_noticed_approver(pool: &PgPool) -> UserId {
    let approver = seed_user(pool, "Independent approver", &["SUPER_ADMIN"], None).await;
    seed_employee_link(pool, approver, "K1-APPROVER", "Independent approver").await;
    sqlx::query(
        "UPDATE authz_grant_ledger SET occurred_at = now() - interval '31 days' WHERE user_id = $1",
    )
    .bind(approver.as_uuid())
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO authz_grant_ledger (org_id, user_id, grant_kind, grant_ref, event, source, channel) SELECT org_id,user_id,grant_kind,grant_ref,'NOTICE_DELIVERED','NOTIFIER','IN_APP' FROM authz_grant_ledger WHERE user_id = $1 AND grant_kind = 'SYSTEM_ROLE'")
        .bind(approver.as_uuid()).execute(pool).await.unwrap();
    approver
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn another_users_passkey_cannot_authorize_the_request(pool: PgPool) {
    let (h, actor, target, employee) = fixture(&pool).await;
    let token = h.token(actor, &["SUPER_ADMIN"], vec![]).await;
    let step_up = fresh_step_up_assertion(&h.pool, target, "Other account").await;
    let (status, body) = send_patch(
        &h,
        &format!("/api/v1/users/{target}"),
        &token,
        json!({ "employee_id": null, "step_up": step_up }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["code"], "step_up_failed");
    assert_eq!(employee_link(&pool, target).await, Some(employee));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn requester_cannot_approve_even_with_another_holder_present(pool: PgPool) {
    let (h, actor, target, employee) = fixture(&pool).await;
    aged_noticed_approver(&pool).await;
    let (status, body) = request_unlink(&h, actor, target, None).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    let id = body["account_link"]["request_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let (status, body) = request_unlink(&h, actor, target, Some(id)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "account_link_second_person_required");
    assert_eq!(employee_link(&pool, target).await, Some(employee));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn young_or_unnoticed_holder_cannot_approve(pool: PgPool) {
    let (h, actor, target, employee) = fixture(&pool).await;
    let young = seed_user(&pool, "Young holder", &["SUPER_ADMIN"], None).await;
    seed_employee_link(&pool, young, "K1-YOUNG", "Young holder").await;
    let (_, body) = request_unlink(&h, actor, target, None).await;
    let id = body["account_link"]["request_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let (status, body) = request_unlink(&h, young, target, Some(id)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "account_link_second_person_required");
    assert_eq!(employee_link(&pool, target).await, Some(employee));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn independent_eligible_approval_applies_once_and_notifies_account(pool: PgPool) {
    let (h, actor, target, _) = fixture(&pool).await;
    let approver = aged_noticed_approver(&pool).await;
    let (status, body) = request_unlink(&h, actor, target, None).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    let id = body["account_link"]["request_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let (status, repeated) = request_unlink(&h, approver, target, None).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{repeated}");
    assert_eq!(repeated["account_link"]["requester_name"], "Link manager");
    assert_eq!(
        repeated["account_link"]["request_id"],
        body["account_link"]["request_id"]
    );
    let (status, body) = request_unlink(&h, approver, target, Some(id)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(employee_link(&pool, target).await, None);
    let (status, body) = request_unlink(&h, approver, target, Some(id)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "account_link_stale");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE action = 'account_link.approved' AND target_id = $1")
        .bind(target.to_string()).fetch_one(&pool).await.unwrap();
    assert_eq!(count, 1);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM notifications WHERE recipient_user_id = $1 AND category = 'account_link'")
        .bind(target.as_uuid()).fetch_one(&pool).await.unwrap();
    assert_eq!(
        count, 3,
        "request, approval and replay refusal each notify the account"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unknown_approval_reference_and_mixed_edits_are_refused(pool: PgPool) {
    let (h, actor, target, employee) = fixture(&pool).await;
    let (status, body) = request_unlink(&h, actor, target, Some(uuid::Uuid::new_v4())).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "account_link_stale");
    let token = h.token(actor, &["SUPER_ADMIN"], vec![]).await;
    let (status, body) = send_patch(
        &h,
        &format!("/api/v1/users/{target}"),
        &token,
        json!({ "employee_id": null, "display_name": "Mixed change" }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["code"], "validation");
    assert_eq!(employee_link(&pool, target).await, Some(employee));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn adapter_caller_cannot_bypass_the_approval_transaction(pool: PgPool) {
    let (h, actor, target, employee) = fixture(&pool).await;
    let result = scope_org(OrgId::one(), async {
        PgOrgStore::new(h.pool.clone())
            .update_user(console_identity_application::UpdateUserCommand {
                actor,
                user_id: target,
                employee_id: Some(None),
                display_name: None,
                phone: None,
                team: None,
                roles: None,
                branch_ids: None,
                preview_receipt_id: None,
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            })
            .await
    })
    .await;
    match result {
        Err(console_identity_adapter_postgres::PgOrgError::Domain(error)) => {
            assert_eq!(error.code, Some("account_link_approval_required"))
        }
        other => panic!("direct adapter link update must be refused: {other:?}"),
    }
    assert_eq!(employee_link(&pool, target).await, Some(employee));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn approval_is_bound_to_the_stored_payload_and_target(pool: PgPool) {
    let (h, actor, target, employee) = fixture(&pool).await;
    let approver = aged_noticed_approver(&pool).await;
    let (_, body) = request_unlink(&h, actor, target, None).await;
    let id: uuid::Uuid = body["account_link"]["request_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let token = h.token(approver, &["SUPER_ADMIN"], vec![]).await;
    let step_up = fresh_step_up_assertion(&h.pool, approver, "Approver").await;
    let (status, body) = send_patch(
        &h,
        &format!("/api/v1/users/{target}"),
        &token,
        json!({ "employee_id": employee, "step_up": step_up, "account_link_request_id": id }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "account_link_stale");
    let other_target = seed_user(&pool, "Another target", &["MECHANIC"], None).await;
    let (status, body) = request_unlink(&h, approver, other_target, Some(id)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "account_link_stale");
    assert_eq!(employee_link(&pool, target).await, Some(employee));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_second_account_of_the_requesters_person_cannot_approve(pool: PgPool) {
    let (h, actor, target, employee) = fixture(&pool).await;
    let own_employee = seed_employee_link(&pool, actor, "K1-REQUESTER", "Requester").await;
    let alias = aged_noticed_approver(&pool).await;
    let alias_employee = employee_link(&pool, alias).await.unwrap();
    let person = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO persons (org_id, id) VALUES ($1, $2)")
        .bind(OrgId::one().as_uuid())
        .bind(person)
        .execute(&pool)
        .await
        .unwrap();
    // Distinct employee records of one natural person are not independent checkers.
    sqlx::query("DELETE FROM employee_person_bindings WHERE org_id=$1 AND employee_id=ANY($2)")
        .bind(OrgId::one().as_uuid())
        .bind(vec![own_employee, alias_employee])
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO employee_person_bindings (org_id, employee_id, person_id, actor_id, payload_digest) SELECT $1, employee, $2, $3, $4 FROM unnest($5::uuid[]) AS employee")
        .bind(OrgId::one().as_uuid())
        .bind(person)
        .bind(actor.as_uuid())
        .bind(vec![0_u8; 32])
        .bind(vec![own_employee, alias_employee])
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = request_unlink(&h, actor, target, None).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    let id = body["account_link"]["request_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let (status, body) = request_unlink(&h, alias, target, Some(id)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "account_link_second_person_required");
    assert_eq!(employee_link(&pool, target).await, Some(employee));
}

#[path = "person_identity.rs"]
mod person_identity;
