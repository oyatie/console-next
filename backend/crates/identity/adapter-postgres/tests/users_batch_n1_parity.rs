// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "account_link_solo/query_count.rs"]
mod query_count;

use std::collections::BTreeSet;

use console_identity_adapter_postgres::PgOrgStore;
use console_identity_application::{DirectoryListQuery, UserListQuery};
use console_kernel_core::{BranchId, BranchScope, OrgId, UserId};
use console_platform_request_context::CURRENT_ORG;
use console_platform_test_support::{MIGRATOR, runtime_role_pool};
use sqlx::{ConnectOptions, PgPool};
use tracing::instrument::WithSubscriber;
use uuid::Uuid;

async fn seed_org_and_branch(pool: &PgPool, org: Uuid, slug: &str) -> Uuid {
    sqlx::query(
        "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
    )
    .bind(org)
    .bind(slug)
    .bind(format!("Org {slug}"))
    .execute(pool)
    .await
    .unwrap();
    let region: Uuid = sqlx::query_scalar(
        "INSERT INTO regions (org_id, name) VALUES ($1, 'Region A') RETURNING id",
    )
    .bind(org)
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, 'Branch A', $2) RETURNING id",
    )
    .bind(region)
    .bind(org)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn seed_user(
    pool: &PgPool,
    org: Uuid,
    branch: Uuid,
    display_name: &str,
    emp_number: Option<&str>,
    login: Option<&str>,
) -> UserId {
    let emp_id = if let Some(num) = emp_number {
        let id: Uuid = sqlx::query_scalar(
            "INSERT INTO employees \
             (org_id, company, name, employee_number, home_branch_id, source_filename, source_sheet, source_row, source_key) \
             VALUES ($1, 'Co', $2, $3, $4, 'seed', 'seed', 1, $5) RETURNING id",
        )
        .bind(org)
        .bind(display_name)
        .bind(num)
        .bind(branch)
        .bind(Uuid::new_v4().to_string())
        .fetch_one(pool)
        .await
        .unwrap();
        Some(id)
    } else {
        None
    };

    let user_id: Uuid = sqlx::query_scalar(
        "INSERT INTO users (display_name, roles, org_id, is_active, employee_id, phone) \
         VALUES ($1, ARRAY['ADMIN'], $2, true, $3, '+821012345678') RETURNING id",
    )
    .bind(display_name)
    .bind(org)
    .bind(emp_id)
    .fetch_one(pool)
    .await
    .unwrap();

    sqlx::query("INSERT INTO user_branches (user_id, branch_id) VALUES ($1, $2)")
        .bind(user_id)
        .bind(branch)
        .execute(pool)
        .await
        .unwrap();

    if let Some(login_part) = login {
        sqlx::query(
            "INSERT INTO user_sign_in_ids (org_id, user_id, login, is_current) \
             VALUES ($1, $2, $3, true)",
        )
        .bind(org)
        .bind(user_id)
        .bind(login_part)
        .execute(pool)
        .await
        .unwrap();
    }
    UserId::from_uuid(user_id)
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn list_users_and_directory_people_have_flat_statement_count_and_safe_search(pool: PgPool) {
    let org_a = OrgId::one();
    let org_b = OrgId::from_uuid(Uuid::new_v4());
    let branch_a = seed_org_and_branch(&pool, *org_a.as_uuid(), "n1-org-a").await;
    let branch_b = seed_org_and_branch(&pool, *org_b.as_uuid(), "n1-org-b").await;

    seed_user(
        &pool,
        *org_b.as_uuid(),
        branch_b,
        "Alpha CrossTenant",
        Some("EMP-B1"),
        Some("alpha-b"),
    )
    .await;

    for i in 0..50 {
        let (name, num, login) = match i {
            0 => (
                "Alpha Special".to_owned(),
                Some("EMP-007"),
                Some("alpha_login"),
            ),
            1 => (
                "Literal 50%_Match".to_owned(),
                Some("EMP-50"),
                Some("lit50"),
            ),
            _ => (format!("Staff Member {i:03}"), None, None),
        };
        seed_user(&pool, *org_a.as_uuid(), branch_a, &name, num, login).await;
    }

    let logging_pool = PgPool::connect_with(
        pool.connect_options()
            .as_ref()
            .clone()
            .log_statements("Debug".parse().unwrap()),
    )
    .await
    .unwrap();
    let store = PgOrgStore::new(runtime_role_pool(&logging_pool).await);
    let scope = BranchScope::Branches(BTreeSet::from([BranchId::from_uuid(branch_a)]));

    // 1. N=1 vs N=50 statement-count parity for list_users.
    let q_one = query_count::QueryCount::default();
    let p_one = CURRENT_ORG
        .scope(
            org_a,
            store.list_users(
                &scope,
                UserListQuery {
                    include_inactive: false,
                    limit: Some(1),
                    offset: Some(0),
                    search: None,
                },
            ),
        )
        .with_subscriber(q_one.clone())
        .await
        .unwrap();
    assert_eq!(p_one.items.len(), 1);
    assert_eq!(p_one.total, 50);

    let q_fifty = query_count::QueryCount::default();
    let p_fifty = CURRENT_ORG
        .scope(
            org_a,
            store.list_users(
                &scope,
                UserListQuery {
                    include_inactive: false,
                    limit: Some(50),
                    offset: Some(0),
                    search: None,
                },
            ),
        )
        .with_subscriber(q_fifty.clone())
        .await
        .unwrap();
    assert_eq!(p_fifty.items.len(), 50);
    assert_eq!(q_fifty.get(), q_one.get());
    assert!(
        p_fifty.items.iter().all(|u| u.phone.is_some()),
        "list_users keeps phone"
    );
    assert!(
        !p_fifty
            .items
            .iter()
            .any(|u| u.display_name == "Alpha CrossTenant")
    );

    // 2. N=1 vs N=50 statement-count parity for list_directory_people (never exposes phone).
    let d_one = query_count::QueryCount::default();
    let dir_one = CURRENT_ORG
        .scope(
            org_a,
            store.list_directory_people(
                &scope,
                DirectoryListQuery {
                    search: None,
                    team: None,
                    branch_id: None,
                    roles: Vec::new(),
                    include_inactive: false,
                    limit: Some(1),
                    offset: Some(0),
                },
            ),
        )
        .with_subscriber(d_one.clone())
        .await
        .unwrap();
    assert_eq!(dir_one.items.len(), 1);

    let d_fifty = query_count::QueryCount::default();
    let dir_fifty = CURRENT_ORG
        .scope(
            org_a,
            store.list_directory_people(
                &scope,
                DirectoryListQuery {
                    search: None,
                    team: None,
                    branch_id: None,
                    roles: Vec::new(),
                    include_inactive: false,
                    limit: Some(50),
                    offset: Some(0),
                },
            ),
        )
        .with_subscriber(d_fifty.clone())
        .await
        .unwrap();
    assert_eq!(dir_fifty.items.len(), 50);
    assert_eq!(d_fifty.get(), d_one.get());
    assert!(dir_fifty.items.iter().all(|u| u.phone.is_none()));

    // 3. Search filter matches display_name, employee_number, login and escapes LIKE wildcards.
    let by_emp = CURRENT_ORG
        .scope(
            org_a,
            store.list_users(
                &scope,
                UserListQuery {
                    include_inactive: false,
                    limit: Some(50),
                    offset: Some(0),
                    search: Some("EMP-007".to_owned()),
                },
            ),
        )
        .await
        .unwrap();
    assert_eq!(by_emp.total, 1);
    assert_eq!(by_emp.items[0].display_name, "Alpha Special");

    let by_lit = CURRENT_ORG
        .scope(
            org_a,
            store.list_users(
                &scope,
                UserListQuery {
                    include_inactive: false,
                    limit: Some(50),
                    offset: Some(0),
                    search: Some("50%_".to_owned()),
                },
            ),
        )
        .await
        .unwrap();
    assert_eq!(by_lit.total, 1);
    assert_eq!(by_lit.items[0].display_name, "Literal 50%_Match");
}
