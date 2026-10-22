// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

async fn fixture(pool: &PgPool) -> (Harness, UserId, UserId, uuid::Uuid) {
    let harness = Harness::new(pool.clone()).await;
    let actor = seed_user(pool, "Link manager", &["SUPER_ADMIN"], None).await;
    let target = seed_user(pool, "Linked account", &["MECHANIC"], None).await;
    let employee = seed_employee_link(pool, target, "K1-001", "김하나").await;
    (harness, actor, target, employee)
}

async fn employee_link(pool: &PgPool, target: UserId) -> Option<uuid::Uuid> {
    sqlx::query_scalar("SELECT employee_id FROM users WHERE id = $1")
        .bind(target.as_uuid())
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn changed_link_requires_step_up_and_records_refusal(pool: PgPool) {
    let (h, actor, target, employee) = fixture(&pool).await;
    let token = h.token(actor, &["SUPER_ADMIN"], vec![]).await;
    let (status, body) = send_patch(
        &h,
        &format!("/api/v1/users/{target}"),
        &token,
        json!({ "employee_id": null }),
    )
    .await;
    assert_eq!(status, StatusCode::PRECONDITION_REQUIRED, "{body}");
    assert_eq!(body["error"]["code"], "step_up_required");
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("reference=")
    );
    assert_eq!(employee_link(&pool, target).await, Some(employee));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE action = 'account_link.refused' AND target_id = $1")
        .bind(target.to_string()).fetch_one(&pool).await.unwrap();
    assert_eq!(count, 1);
    let notices: i64 = sqlx::query_scalar("SELECT count(*) FROM notifications WHERE recipient_user_id = $1 AND category = 'account_link'")
        .bind(target.as_uuid()).fetch_one(&pool).await.unwrap();
    assert_eq!(notices, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn request_waits_without_applying_and_notifies_target(pool: PgPool) {
    let (h, actor, target, employee) = fixture(&pool).await;
    let token = h.token(actor, &["SUPER_ADMIN"], vec![]).await;
    let step_up = fresh_step_up_assertion(&h.pool, actor, "Link manager").await;
    let (status, body) = send_patch(
        &h,
        &format!("/api/v1/users/{target}"),
        &token,
        json!({ "employee_id": null, "step_up": step_up }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    assert_eq!(body["account_link"]["status"], "PENDING");
    assert!(body["account_link"]["request_id"].is_string());
    assert_eq!(body["account_link"]["requester_name"], "Link manager");
    let (status, repeated) = request_unlink(&h, actor, target, None).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{repeated}");
    assert_eq!(repeated["account_link"]["requester_name"], "Link manager");
    assert_eq!(employee_link(&pool, target).await, Some(employee));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM notifications WHERE recipient_user_id = $1 AND category = 'account_link'")
        .bind(target.as_uuid()).fetch_one(&pool).await.unwrap();
    assert_eq!(count, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn self_unlink_then_relink_never_changes_own_record_identity(pool: PgPool) {
    let (h, actor, target, other_employee) = fixture(&pool).await;
    let own_employee = seed_employee_link(&pool, actor, "K1-SELF", "Link manager").await;
    let token = h.token(actor, &["SUPER_ADMIN"], vec![]).await;
    for desired in [Value::Null, json!(other_employee)] {
        let step_up = fresh_step_up_assertion(&h.pool, actor, "Link manager").await;
        let (status, body) = send_patch(
            &h,
            &format!("/api/v1/users/{actor}"),
            &token,
            json!({ "employee_id": desired, "step_up": step_up }),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(body["error"]["code"], "account_link_self_forbidden");
        assert_eq!(employee_link(&pool, actor).await, Some(own_employee));
        assert_ne!(
            employee_link(&pool, actor).await,
            employee_link(&pool, target).await
        );
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unchanged_link_and_profile_edits_need_no_step_up(pool: PgPool) {
    let (h, actor, target, employee) = fixture(&pool).await;
    let token = h.token(actor, &["SUPER_ADMIN"], vec![]).await;
    let (status, body) = send_patch(
        &h,
        &format!("/api/v1/users/{target}"),
        &token,
        json!({ "employee_id": employee, "display_name": "새 이름" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["display_name"], "새 이름");
}

async fn request_unlink(
    h: &Harness,
    actor: UserId,
    target: UserId,
    request_id: Option<uuid::Uuid>,
) -> (StatusCode, Value) {
    let token = h.token(actor, &["SUPER_ADMIN"], vec![]).await;
    let step_up = fresh_step_up_assertion(&h.pool, actor, "Link manager").await;
    send_patch(
        h,
        &format!("/api/v1/users/{target}"),
        &token,
        json!({ "employee_id": null, "step_up": step_up, "account_link_request_id": request_id }),
    )
    .await
}

pub(super) async fn seed_employee_link(
    pool: &PgPool,
    user_id: UserId,
    number: &str,
    name: &str,
) -> uuid::Uuid {
    let employee_id = uuid::Uuid::new_v4();
    let number = number.to_owned();
    let name = name.to_owned();
    let event = AuditEvent::new(
        None,
        AuditAction::new("test.seed_employee_link").unwrap(),
        "employee",
        employee_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(OrgId::one());
    with_audit(pool, event, |tx| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO employees \
                 (id, org_id, company, name, employee_number, source_filename, source_sheet, source_row, source_key) \
                 VALUES ($1, $2, 'Test Company', $3, $4, 'test.csv', 'employees', 1, $5)",
            )
            .bind(employee_id)
            .bind(*OrgId::one().as_uuid())
            .bind(name)
            .bind(&number)
            .bind(format!("test:{number}"))
            .execute(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            sqlx::query("UPDATE users SET employee_id = $1 WHERE id = $2")
                .bind(employee_id)
                .bind(*user_id.as_uuid())
                .execute(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)?;
            Ok::<(), DbError>(())
        })
    })
    .await
    .unwrap();
    employee_id
}

#[path = "account_link_approval.rs"]
mod approval;
