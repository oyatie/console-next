// SPDX-License-Identifier: LicenseRef-Proprietary
use super::person_identity::people;
use super::*;

async fn request_relink(
    h: &Harness,
    actor: UserId,
    target: UserId,
    employee: uuid::Uuid,
    request: Option<uuid::Uuid>,
) -> (StatusCode, Value) {
    let token = h.token(actor, &["SUPER_ADMIN"], vec![]).await;
    let step_up = fresh_step_up_assertion(&h.pool, actor, "Link manager").await;
    send_patch(
        h,
        &format!("/api/v1/users/{target}"),
        &token,
        json!({ "employee_id": employee, "step_up": step_up, "account_link_request_id": request }),
    )
    .await
}

async fn available_employee(pool: &PgPool) -> uuid::Uuid {
    let holder = seed_user(pool, "Former holder", &["MECHANIC"], None).await;
    let employee = seed_employee_link(pool, holder, "RELINK-NEW", "Replacement employee").await;
    sqlx::query("UPDATE users SET employee_id=NULL WHERE id=$1")
        .bind(holder.as_uuid())
        .execute(pool)
        .await
        .unwrap();
    employee
}

fn proposal_id(body: &Value) -> uuid::Uuid {
    body["account_link"]["request_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap()
}

async fn refused_count(pool: &PgPool, target: UserId, code: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE action='account_link.refused' AND target_id=$1 AND after_snap->>'code'=$2")
        .bind(target.to_string()).bind(code).fetch_one(pool).await.unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn occupied_employee_is_refused_before_creating_a_link_or_relink_request(pool: PgPool) {
    let (h, actor, target, previous) = fixture(&pool).await;
    let holder = seed_user(&pool, "Existing holder", &["MECHANIC"], None).await;
    let occupied = seed_employee_link(&pool, holder, "RELINK-TAKEN", "Occupied employee").await;
    let unlinked = seed_user(&pool, "Unlinked account", &["MECHANIC"], None).await;
    for (account, expected) in [(target, Some(previous)), (unlinked, None)] {
        let (status, body) = request_relink(&h, actor, account, occupied, None).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["error"]["code"], "account_link.refuse.employee_taken");
        assert_eq!(employee_link(&pool, account).await, expected);
        let requests: i64 =
            sqlx::query_scalar("SELECT count(*) FROM account_link_requests WHERE user_id=$1")
                .bind(account.as_uuid())
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(requests, 0);
        assert_eq!(
            refused_count(&pool, account, "account_link.refuse.employee_taken").await,
            1
        );
    }
    assert_eq!(employee_link(&pool, holder).await, Some(occupied));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn employee_taken_while_pending_is_refused_without_deciding_the_request(pool: PgPool) {
    let (h, actor, target, previous) = fixture(&pool).await;
    let approver = aged_noticed_approver(&pool).await;
    let employee = available_employee(&pool).await;
    let (status, body) = request_relink(&h, actor, target, employee, None).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    let request = proposal_id(&body);
    let holder = seed_user(&pool, "New holder", &["MECHANIC"], None).await;
    sqlx::query("UPDATE users SET employee_id=$1 WHERE id=$2")
        .bind(employee)
        .bind(holder.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = request_relink(&h, approver, target, employee, Some(request)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "account_link.refuse.employee_taken");
    assert_eq!(employee_link(&pool, target).await, Some(previous));
    assert_eq!(employee_link(&pool, holder).await, Some(employee));
    let state: String = sqlx::query_scalar("SELECT status FROM account_link_requests WHERE id=$1")
        .bind(request)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(state, "PENDING");
    assert_eq!(
        refused_count(&pool, target, "account_link.refuse.employee_taken").await,
        1
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn concurrent_employee_claim_is_refused_before_approval(pool: PgPool) {
    let (h, actor, target, previous) = fixture(&pool).await;
    people::bind_user_to_distinct_person(&pool, actor).await;
    let approver = aged_noticed_approver(&pool).await;
    people::bind_user_to_distinct_person(&pool, approver).await;
    let employee = available_employee(&pool).await;
    let (status, body) = request_relink(&h, actor, target, employee, None).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    let request = proposal_id(&body);
    let holder = seed_user(&pool, "Concurrent holder", &["MECHANIC"], None).await;
    let mut writer = pool.begin().await.unwrap();
    sqlx::query("UPDATE users SET employee_id=$1 WHERE id=$2")
        .bind(employee)
        .bind(holder.as_uuid())
        .execute(writer.as_mut())
        .await
        .unwrap();
    let approval =
        tokio::spawn(
            async move { request_relink(&h, approver, target, employee, Some(request)).await },
        );
    // Hold the competing link until approval waits on the employee lock.
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            let waiting: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock')")
                .fetch_one(&pool).await.unwrap();
            if waiting { break; }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }).await.unwrap();
    writer.commit().await.unwrap();
    let (status, body) = approval.await.unwrap();
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "account_link.refuse.employee_taken");
    assert_eq!(employee_link(&pool, target).await, Some(previous));
    assert_eq!(employee_link(&pool, holder).await, Some(employee));
    assert_eq!(
        refused_count(&pool, target, "account_link.refuse.employee_taken").await,
        1
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn relink_requires_a_second_person_and_applies_and_audits_only_once(pool: PgPool) {
    let (h, actor, target, previous) = fixture(&pool).await;
    people::bind_user_to_distinct_person(&pool, actor).await;
    let approver = aged_noticed_approver(&pool).await;
    people::bind_user_to_distinct_person(&pool, approver).await;
    let employee = available_employee(&pool).await;
    let (status, body) = request_relink(&h, actor, target, employee, None).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    let request = proposal_id(&body);
    assert_eq!(employee_link(&pool, target).await, Some(previous));
    let stored_previous: Option<uuid::Uuid> =
        sqlx::query_scalar("SELECT previous_employee_id FROM account_link_requests WHERE id=$1")
            .bind(request)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(stored_previous, Some(previous));
    let (status, body) = request_relink(&h, actor, target, employee, Some(request)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "account_link_second_person_required");
    assert_eq!(employee_link(&pool, target).await, Some(previous));
    let (status, body) = request_relink(&h, approver, target, employee, None).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    assert_eq!(proposal_id(&body), request);
    let (status, body) = request_relink(&h, approver, target, employee, Some(request)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(employee_link(&pool, target).await, Some(employee));
    let (status, body) = request_relink(&h, approver, target, employee, Some(request)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "account_link_stale");
    for action in ["account_link.requested", "account_link.approved"] {
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM audit_events WHERE action=$1 AND target_id=$2",
        )
        .bind(action)
        .bind(target.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 1, "{action}");
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn relink_is_stale_if_the_previous_employee_changes_before_approval(pool: PgPool) {
    let (h, actor, target, _) = fixture(&pool).await;
    let approver = aged_noticed_approver(&pool).await;
    let employee = available_employee(&pool).await;
    let (status, body) = request_relink(&h, actor, target, employee, None).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    let request = proposal_id(&body);
    sqlx::query("UPDATE users SET employee_id=NULL WHERE id=$1")
        .bind(target.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = request_relink(&h, approver, target, employee, Some(request)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "account_link_stale");
    assert_eq!(employee_link(&pool, target).await, None);
    assert_eq!(refused_count(&pool, target, "account_link_stale").await, 1);
}
