#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! A branch-scoped reader's list, facets and export all stop at its own
//! branches (one filtered query behind all three); an empty scope fails
//! closed.

mod support;

use std::collections::BTreeSet;

use console_hr_adapter_postgres::directory::read_export::ExportPurposeQuery;
use console_kernel_core::{BranchId, BranchScope, OrgId, UserId};
use console_platform_authz::{Principal, Role};
use futures::StreamExt;
use sqlx::PgPool;
use support::{employee, no_filters, tenant, user};
use uuid::Uuid;

async fn branch(pool: &PgPool, org: Uuid, region: Uuid, name: &str) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(region)
    .bind(name)
    .bind(org)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn home(pool: &PgPool, employee: Uuid, branch: Uuid) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE employees SET home_branch_id = $1 WHERE id = $2")
        .bind(branch)
        .bind(employee)
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

fn admin(org: Uuid, user: UserId, scope: BranchScope) -> Principal {
    Principal::new(
        user,
        OrgId::from_uuid(org),
        BTreeSet::from([Role::Admin]),
        scope,
    )
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_branch_admin_lists_counts_and_exports_only_its_branch(pool: PgPool) {
    let t = tenant(&pool).await;
    let region: Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ('R', $1) RETURNING id")
            .bind(t.org)
            .fetch_one(&pool)
            .await
            .unwrap();
    let (a, b) = (
        branch(&pool, t.org, region, "A").await,
        branch(&pool, t.org, region, "B").await,
    );
    let in_a = employee(&pool, t.org, "In A", "A-1", "ACTIVE").await;
    let in_b = employee(&pool, t.org, "In B", "B-1", "ACTIVE").await;
    employee(&pool, t.org, "No branch", "N-1", "ACTIVE").await;
    home(&pool, in_a, a).await;
    home(&pool, in_b, b).await;
    let hr_user = user(&pool, t.org, None).await;
    let scoped = || {
        admin(
            t.org,
            hr_user,
            BranchScope::Branches(BTreeSet::from([BranchId::from_uuid(a)])),
        )
    };

    let page = t.hr.list_employees(scoped(), no_filters()).await.unwrap();
    assert_eq!(
        page.items.iter().map(|e| e.id).collect::<Vec<_>>(),
        vec![in_a]
    );
    assert_eq!(page.total, 1);

    let facets = t.hr.employee_facets(scoped(), no_filters()).await.unwrap();
    assert_eq!(facets.total, 1);
    assert_eq!(facets.status.iter().map(|f| f.count).sum::<i64>(), 1);

    let body =
        t.hr.export_employees_csv(
            scoped(),
            no_filters(),
            ExportPurposeQuery {
                export_purpose: Some("OTHER".to_owned()),
                layout: None,
            },
        )
        .await
        .unwrap()
        .1
        .map(|chunk| chunk.unwrap())
        .collect::<Vec<_>>()
        .await
        .concat();
    assert_eq!(body.trim_end().split("\r\n").count(), 2, "{body}");
    assert!(body.contains("In A") && !body.contains("In B") && !body.contains("No branch"));
    let scope_key: String =
        sqlx::query_scalar("SELECT scope_key FROM excel_export_logs WHERE org_id = $1")
            .bind(t.org)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(scope_key, a.to_string());

    let none = admin(t.org, hr_user, BranchScope::none());
    assert!(
        t.hr.list_employees(none.clone(), no_filters())
            .await
            .is_err()
    );
    assert!(t.hr.employee_facets(none, no_filters()).await.is_err());
}
