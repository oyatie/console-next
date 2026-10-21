#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Shared fixtures for the HR adapter's Postgres tests. The service runs as the
//! runtime role `console_rt`, so RLS is armed as in production.
//! - BW-17 change requests: one org with two branches, an employee homed in
//!   each, two branch ADMINs and two HR (SUPER_ADMIN) users ([`world`]).
//! - PEOPLE-B directory reads ([`tenant`] and the helpers after it).

pub mod passkey;

use std::collections::BTreeSet;

use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::corrections::SecondPersonContext;
use console_hr_adapter_postgres::directory::read_list::EmployeeListQuery;
use console_hr_adapter_postgres::requests::{
    ChangeRequestListQuery, CreateChangeRequest, DecideChangeRequest,
};
use console_kernel_core::{BranchId, BranchScope, OrgId, UserId};
use console_platform_authz::{Principal, Role};
use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

/// Another eligible holder exists: the second-person path.
pub const SECOND: SecondPersonContext = SecondPersonContext {
    other_eligible_holders: 1,
    routed: true,
    sole_holder_refuse: false,
};

pub struct World {
    pub hr: HrService,
    pub org: Uuid,
    pub branch_a: Uuid,
    pub in_a: Uuid,
    pub in_b: Uuid,
    pub admin_a: Uuid,
    pub admin_b: Uuid,
    pub hr_one: Uuid,
    pub hr_two: Uuid,
}

pub async fn world(pool: &PgPool) -> World {
    let (org, region, branch_a, branch_b) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, 'bw17', 'BW-17')")
        .bind(org)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO regions (id, name, org_id) VALUES ($1, 'R', $2)")
        .bind(region)
        .bind(org)
        .execute(pool)
        .await
        .unwrap();
    for (branch, name) in [(branch_a, "A"), (branch_b, "B")] {
        sqlx::query("INSERT INTO branches (id, region_id, name, org_id) VALUES ($1, $2, $3, $4)")
            .bind(branch)
            .bind(region)
            .bind(name)
            .bind(org)
            .execute(pool)
            .await
            .unwrap();
    }
    let mut users = Vec::new();
    for role in ["ADMIN", "ADMIN", "SUPER_ADMIN", "SUPER_ADMIN"] {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO users (id, display_name, roles, is_active, org_id) \
             VALUES ($1, 'U', ARRAY[$2]::text[], true, $3)",
        )
        .bind(id)
        .bind(role)
        .bind(org)
        .execute(pool)
        .await
        .unwrap();
        users.push(id);
    }
    let mut employees = Vec::new();
    for branch in [branch_a, branch_b] {
        let id = Uuid::new_v4();
        let mut tx = pool.begin().await.unwrap();
        // home_branch_id is leave-command-only (0166 guard); fixtures skip it.
        sqlx::query("SET LOCAL session_replication_role = replica")
            .execute(tx.as_mut())
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO employees (id, org_id, company, name, source_filename, source_sheet, \
             source_row, source_key, raw_row, source_metadata, home_branch_id) \
             VALUES ($1, $2, 'Test', 'E', 'test.xlsx', 'Sheet', 1, $3, '{}', '{}', $4)",
        )
        .bind(id)
        .bind(org)
        .bind(format!("key-{id}"))
        .bind(branch)
        .execute(tx.as_mut())
        .await
        .unwrap();
        tx.commit().await.unwrap();
        employees.push(id);
    }
    let options = pool.connect_options().as_ref().clone();
    let runtime = PgPoolOptions::new()
        .max_connections(4)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_rt").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .unwrap();
    let _ = branch_b;
    World {
        hr: HrService::new(runtime),
        org,
        branch_a,
        in_a: employees[0],
        in_b: employees[1],
        admin_a: users[0],
        admin_b: users[1],
        hr_one: users[2],
        hr_two: users[3],
    }
}

impl World {
    pub fn admin(&self, user: Uuid, branch: Uuid) -> Principal {
        Principal::new(
            UserId::from_uuid(user),
            OrgId::from_uuid(self.org),
            BTreeSet::from([Role::Admin]),
            BranchScope::Branches(BTreeSet::from([BranchId::from_uuid(branch)])),
        )
    }
    pub fn hr(&self, user: Uuid) -> Principal {
        Principal::new(
            UserId::from_uuid(user),
            OrgId::from_uuid(self.org),
            BTreeSet::from([Role::SuperAdmin]),
            BranchScope::All,
        )
    }
}

pub fn create(
    kind: &str,
    subject_type: &str,
    subject: Uuid,
    payload: serde_json::Value,
) -> CreateChangeRequest {
    serde_json::from_value(json!({
        "kind": kind, "subject_type": subject_type, "subject_id": subject,
        "payload": payload, "reason_code": "DATA_ENTRY_ERROR", "note": "n"
    }))
    .unwrap()
}

pub fn decide(decision: &str) -> DecideChangeRequest {
    serde_json::from_value(json!({ "decision": decision, "reason_code": "CONFIRMED" })).unwrap()
}

pub fn list(assignee: Option<&str>) -> ChangeRequestListQuery {
    serde_json::from_value(json!({ "assignee": assignee })).unwrap()
}

// --- PEOPLE-B directory fixtures ---

pub struct Tenant {
    pub org: Uuid,
    pub hr: HrService,
}

pub async fn tenant(pool: &PgPool) -> Tenant {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'People B')")
        .bind(org)
        .bind(format!("pb-{}", &org.simple().to_string()[..12]))
        .execute(pool)
        .await
        .unwrap();
    let options = pool.connect_options().as_ref().clone();
    let runtime = PgPoolOptions::new()
        .max_connections(4)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_rt").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .unwrap();
    Tenant {
        org,
        hr: HrService::new(runtime),
    }
}

/// A signed-up account (audit rows reference `users`), optionally linked to
/// an employee record.
pub async fn user(pool: &PgPool, org: Uuid, employee: Option<Uuid>) -> UserId {
    let user = UserId::new();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id, employee_id) \
         VALUES ($1, 'HR', ARRAY['SUPER_ADMIN'], $2, $3)",
    )
    .bind(*user.as_uuid())
    .bind(org)
    .bind(employee)
    .execute(pool)
    .await
    .unwrap();
    user
}

pub fn principal(org: Uuid, user: UserId) -> Principal {
    Principal::new(
        user,
        OrgId::from_uuid(org),
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    )
}

/// An employee row (fixture insert skips the 0166 home-branch writer guard).
pub async fn employee(pool: &PgPool, org: Uuid, name: &str, number: &str, status: &str) -> Uuid {
    let id = Uuid::new_v4();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO employees (id, org_id, company, name, employee_number, employment_status, \
         source_filename, source_sheet, source_row, source_key, raw_row, source_metadata) \
         VALUES ($1, $2, 'Test', $3, $4, $5, 'test.xlsx', 'Sheet', 1, $6, '{}', '{}')",
    )
    .bind(id)
    .bind(org)
    .bind(name)
    .bind(number)
    .bind(status)
    .bind(format!("key-{id}"))
    .execute(tx.as_mut())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    id
}

pub fn query(value: Value) -> EmployeeListQuery {
    serde_json::from_value(value).unwrap()
}

pub fn no_filters() -> EmployeeListQuery {
    query(json!({}))
}

/// `(action, target_id, after_snap)` of the tenant's audit rows with an
/// `employee.` action other than create, oldest first.
pub async fn access_rows(pool: &PgPool, org: Uuid) -> Vec<(String, String, Value)> {
    sqlx::query_as(
        "SELECT action, target_id, after_snap FROM audit_events \
         WHERE org_id = $1 AND action LIKE 'employee.%' AND action <> 'employee.create' \
         ORDER BY occurred_at, created_at",
    )
    .bind(org)
    .fetch_all(pool)
    .await
    .unwrap()
}
