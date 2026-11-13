// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! A requester whose people-directory scope is a set of branches reaches only
//! the accounts placed in them, proven as the runtime role `console_rt`. Every
//! caller allowed to ask today has a whole-tenant scope, so only this test
//! runs the branch arm of the assignee check.

use std::collections::BTreeSet;

use console_kernel_core::{BranchId, BranchScope, KernelError, OrgId, TraceContext, UserId};
use console_platform_request_context::scope_org;
use console_todos_adapter_postgres::PgTodoStore;
use console_todos_application::CreateTodoRequestCommand;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::OffsetDateTime;
use uuid::Uuid;

async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(2)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_rt").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .unwrap()
}

async fn branch(pool: &PgPool, org: Uuid) -> BranchId {
    let region: Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind(format!("권역 {}", Uuid::new_v4()))
            .bind(org)
            .fetch_one(pool)
            .await
            .unwrap();
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, '지점', $2) RETURNING id",
    )
    .bind(region)
    .bind(org)
    .fetch_one(pool)
    .await
    .unwrap();
    BranchId::from_uuid(id)
}

async fn account(pool: &PgPool, org: Uuid, placed: Option<BranchId>) -> UserId {
    let user = UserId::new();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, '시험자', '{}', $2)",
    )
    .bind(user.as_uuid())
    .bind(org)
    .execute(pool)
    .await
    .unwrap();
    if let Some(branch) = placed {
        sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
            .bind(user.as_uuid())
            .bind(branch.as_uuid())
            .bind(org)
            .execute(pool)
            .await
            .unwrap();
    }
    user
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_branch_scoped_requester_reaches_only_accounts_in_its_branches(owner_pool: PgPool) {
    let org = OrgId::one();
    let raw = *org.as_uuid();
    let (mine, theirs) = (
        branch(&owner_pool, raw).await,
        branch(&owner_pool, raw).await,
    );
    let requester = account(&owner_pool, raw, Some(mine)).await;
    let inside = account(&owner_pool, raw, Some(mine)).await;
    let outside = account(&owner_pool, raw, Some(theirs)).await;
    let store = PgTodoStore::new(runtime_role_pool(&owner_pool).await);
    let ask = |assignee: UserId, assignee_scope: BranchScope| CreateTodoRequestCommand {
        requester,
        assignee,
        text: "주간 점검표 확인".to_owned(),
        due_on: None,
        links: Vec::new(),
        assignee_scope,
        trace: TraceContext::generate(),
        occurred_at: OffsetDateTime::now_utc(),
    };

    let made = scope_org(
        org,
        store.create_request(ask(inside, BranchScope::single(mine))),
    )
    .await
    .unwrap();
    assert_eq!(made.owner_user_id, inside);
    for (assignee, scope) in [
        (outside, BranchScope::single(mine)),
        (inside, BranchScope::Branches(BTreeSet::new())),
    ] {
        let refused = scope_org(org, store.create_request(ask(assignee, scope)))
            .await
            .unwrap_err();
        assert_eq!(
            KernelError::from(refused).code,
            Some("todo_assignee_out_of_scope")
        );
    }
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM todos WHERE org_id = $1")
        .bind(raw)
        .fetch_one(&owner_pool)
        .await
        .unwrap();
    assert_eq!(rows, 1);
}
