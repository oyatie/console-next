// SPDX-License-Identifier: LicenseRef-Proprietary
//! An invite or a relink links an account only to an employee inside the editor's
//! own account-management scope.

use super::policy_role_ceiling::access_editor;
use super::*;

/// A workplace of its own legal entity, routed to a fresh branch.
async fn workplace(pool: &PgPool, founder: UserId) -> (uuid::Uuid, BranchId) {
    let branch = seed_branch(pool).await;
    let org = *OrgId::one().as_uuid();
    let entity = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO legal_entities (org_id,id,biz_kind,created_change_mode,created_by) VALUES ($1,$2,'INDIVIDUAL','SETUP',$3)")
        .bind(org).bind(entity).bind(founder.as_uuid()).execute(pool).await.unwrap();
    let id = sqlx::query_scalar("INSERT INTO workplaces (org_id,legal_entity_id,default_branch_id,created_change_mode,created_by) VALUES ($1,$2,$3,'SETUP',$4) RETURNING id")
        .bind(org).bind(entity).bind(branch.as_uuid()).bind(founder.as_uuid()).fetch_one(pool).await.unwrap();
    (id, branch)
}

/// An employee with no account, homed in `branch` when one is given.
async fn employee_homed_in(pool: &PgPool, branch: Option<BranchId>, number: &str) -> uuid::Uuid {
    let holder = seed_user(pool, "Former holder", &[], None).await;
    let employee = seed_employee_link(pool, holder, number, "Synthetic employee").await;
    sqlx::query("UPDATE users SET employee_id = NULL WHERE id = $1")
        .bind(holder.as_uuid())
        .execute(pool)
        .await
        .unwrap();
    let Some(branch) = branch else {
        return employee;
    };
    // The home branch is command-only; the fixture writes past its guard.
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE employees SET home_branch_id = $2 WHERE id = $1")
        .bind(employee)
        .bind(branch.as_uuid())
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    employee
}

async fn invite(h: &Harness, token: &str, name: &str, employee: uuid::Uuid) -> (StatusCode, Value) {
    send(
        h,
        "POST",
        "/api/v1/users",
        token,
        Some(json!({ "display_name": name, "employee_id": employee })),
    )
    .await
}

async fn accounts_linked_to(pool: &PgPool, employee: uuid::Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM users WHERE employee_id = $1")
        .bind(employee)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_invite_links_only_an_employee_inside_the_inviters_scope(pool: PgPool) {
    let h = Harness::new(pool.clone()).await;
    let founder = seed_user(&pool, "Founder", &["SUPER_ADMIN"], None).await;
    let (here, here_branch) = workplace(&pool, founder).await;
    let (_, there_branch) = workplace(&pool, founder).await;
    let admin = access_editor(&pool, "Workplace admin", Some(here), founder).await;
    let token = h.token(admin, &[], vec![]).await;
    let inside = employee_homed_in(&pool, Some(here_branch), "SCOPE-IN").await;
    let outside = employee_homed_in(&pool, Some(there_branch), "SCOPE-OUT").await;

    let accounts = || async {
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM users")
            .fetch_one(&pool)
            .await
            .unwrap()
    };
    let unplaced = employee_homed_in(&pool, None, "SCOPE-NONE").await;
    let before = accounts().await;
    for employee in [outside, unplaced, uuid::Uuid::new_v4()] {
        let (status, body) = invite(&h, &token, "Outside invite", employee).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(body["error"]["code"], "forbidden");
        assert_eq!(
            accounts_linked_to(&pool, employee).await,
            0,
            "nothing linked"
        );
    }
    assert_eq!(accounts().await, before, "no account written");

    let (status, body) = invite(&h, &token, "Inside invite", inside).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["employee_id"], inside.to_string());

    // The founder and a tenant-wide account administrator still invite anyone, placed or not.
    let founder_token = h.token(founder, &["SUPER_ADMIN"], vec![]).await;
    let (status, body) = invite(&h, &founder_token, "Founder invite", outside).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let tenant_admin = access_editor(&pool, "Tenant admin", None, founder).await;
    let tenant_token = h.token(tenant_admin, &[], vec![]).await;
    let (status, body) = invite(&h, &tenant_token, "Tenant invite", unplaced).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_relink_names_only_an_employee_inside_the_editors_scope(pool: PgPool) {
    let h = Harness::new(pool.clone()).await;
    let founder = seed_user(&pool, "Founder", &["SUPER_ADMIN"], None).await;
    let (here, here_branch) = workplace(&pool, founder).await;
    let (_, there_branch) = workplace(&pool, founder).await;
    let admin = access_editor(&pool, "Workplace admin", Some(here), founder).await;
    let token = h.token(admin, &[], vec![]).await;
    let account = seed_user(&pool, "Workplace account", &[], Some(here_branch)).await;
    let relink = |employee: uuid::Uuid| {
        let (h, token) = (&h, &token);
        async move {
            let step_up = fresh_step_up_assertion(&h.pool, admin, "Workplace admin").await;
            send_patch(
                h,
                &format!("/api/v1/users/{account}"),
                token,
                json!({ "employee_id": employee, "step_up": step_up }),
            )
            .await
        }
    };

    let outside = employee_homed_in(&pool, Some(there_branch), "RELINK-OUT").await;
    let unplaced = employee_homed_in(&pool, None, "RELINK-NONE").await;
    for employee in [outside, unplaced] {
        let (status, body) = relink(employee).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(body["error"]["code"], "forbidden");
        assert_eq!(accounts_linked_to(&pool, employee).await, 0);
        let requests: i64 =
            sqlx::query_scalar("SELECT count(*) FROM account_link_requests WHERE user_id = $1")
                .bind(account.as_uuid())
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(requests, 0, "no link request opened");
    }

    let inside = employee_homed_in(&pool, Some(here_branch), "RELINK-IN").await;
    let (status, body) = relink(inside).await;
    assert!(status.is_success(), "{status} {body}");
}
