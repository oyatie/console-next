#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! BW-22: a branch-scoped reader lists only its branch's employees, and the
//! detail of another branch's (or a branchless) employee reads as 404. Runs as
//! the runtime role `console_rt` so RLS is armed as in production.

use std::collections::BTreeSet;

use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::directory::read_list::EmployeeListQuery;
use console_kernel_core::{BranchId, BranchScope, OrgId, UserId};
use console_platform_authz::{Principal, Role};
use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(4)
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

async fn exec(pool: &PgPool, sql: &'static str, binds: &[Uuid]) {
    let mut query = sqlx::query(sql);
    for bind in binds {
        query = query.bind(*bind);
    }
    query.execute(pool).await.unwrap();
}

async fn employee(pool: &PgPool, org: Uuid, name: &str, home_branch: Option<Uuid>) -> Uuid {
    let id = Uuid::new_v4();
    // home_branch_id is leave-command-only (0166 writer guard); a fixture
    // insert skips triggers for its own transaction.
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO employees (id, org_id, company, name, source_filename, source_sheet, \
         source_row, source_key, raw_row, source_metadata, home_branch_id, hire_date, hire_on) \
         VALUES ($1, $2, 'Test', $3, 'test.xlsx', 'Sheet', 1, $4, '{}', '{}', $5, '2026-09-01', '2026-09-01')",
    )
    .bind(id)
    .bind(org)
    .bind(name)
    .bind(format!("key-{id}"))
    .bind(home_branch)
    .execute(tx.as_mut())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    id
}

/// The reader's account: every read writes a 접속기록 row naming its actor.
async fn reader(pool: &PgPool, org: Uuid) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, is_active, org_id) \
         VALUES ($1, 'Reader', ARRAY['ADMIN']::text[], true, $2)",
    )
    .bind(id)
    .bind(org)
    .execute(pool)
    .await
    .unwrap();
    id
}

fn principal(org: Uuid, user: Uuid, role: Role, scope: BranchScope) -> Principal {
    Principal::new(
        UserId::from_uuid(user),
        OrgId::from_uuid(org),
        BTreeSet::from([role]),
        scope,
    )
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_branch_admin_reads_only_its_own_branch(pool: PgPool) {
    let (org, region, branch_a, branch_b) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    exec(
        &pool,
        "INSERT INTO organizations (id, slug, name) VALUES ($1, 'bw22', 'BW-22')",
        &[org],
    )
    .await;
    exec(
        &pool,
        "INSERT INTO regions (id, name, org_id) VALUES ($1, 'R', $2)",
        &[region, org],
    )
    .await;
    for (branch, name) in [(branch_a, "A"), (branch_b, "B")] {
        sqlx::query("INSERT INTO branches (id, region_id, name, org_id) VALUES ($1, $2, $3, $4)")
            .bind(branch)
            .bind(region)
            .bind(name)
            .bind(org)
            .execute(&pool)
            .await
            .unwrap();
    }
    let in_a = employee(&pool, org, "In A", Some(branch_a)).await;
    let in_b = employee(&pool, org, "In A", Some(branch_b)).await;
    let branchless = employee(&pool, org, "In A", None).await;

    let user = reader(&pool, org).await;
    let hr = HrService::new(runtime_role_pool(&pool).await);
    let admin_a = || {
        principal(
            org,
            user,
            Role::Admin,
            BranchScope::Branches(BTreeSet::from([BranchId::from_uuid(branch_a)])),
        )
    };
    let query = || serde_json::from_value::<EmployeeListQuery>(json!({})).unwrap();

    let page = hr.list_employees(admin_a(), query()).await.unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(
        page.items.iter().map(|e| e.id).collect::<Vec<_>>(),
        vec![in_a]
    );

    let own = hr.employee_detail(admin_a(), in_a).await.unwrap();
    assert_eq!(own.employee.id, in_a);
    assert!(
        own.warnings.is_empty(),
        "a warning cannot disclose a namesake outside the reader's grant"
    );

    for other in [in_b, branchless] {
        let err = hr.employee_detail(admin_a(), other).await.unwrap_err();
        assert_eq!(
            err.status,
            StatusCode::NOT_FOUND,
            "{other}: {}",
            err.message
        );
    }
    // A refused detail showed nothing, so it leaves no 접속기록 row (INF-02).
    let read: Vec<String> = sqlx::query_scalar(
        "SELECT target_id FROM audit_events WHERE org_id = $1 AND action = 'employee.read'",
    )
    .bind(org)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(read, vec![in_a.to_string()]);

    // An org-wide reader still sees everyone, branchless included.
    let all = principal(org, user, Role::SuperAdmin, BranchScope::All);
    assert_eq!(
        hr.list_employees(all.clone(), query()).await.unwrap().total,
        3
    );
    let visible = hr.employee_detail(all, in_a).await.unwrap();
    let namesakes = visible
        .warnings
        .iter()
        .find(|w| w.code == "same_name_same_hire_date")
        .unwrap();
    assert_eq!(namesakes.employee_ids.len(), 2);
    assert!(namesakes.employee_ids.contains(&in_b));
    assert!(namesakes.employee_ids.contains(&branchless));
    let exec_all = principal(org, user, Role::Executive, BranchScope::All);
    hr.employee_detail(exec_all, branchless).await.unwrap();

    // An empty scope fails closed.
    let none = principal(org, user, Role::Admin, BranchScope::none());
    assert!(hr.list_employees(none, query()).await.is_err());
}
