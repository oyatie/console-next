// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]

use console_kernel_core::UserId;
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

#[path = "../support/go_live.rs"]
pub mod go_live;
#[allow(dead_code)]
#[path = "../emp_ui_routes/harness.rs"]
pub mod harness;

pub fn code(body: &Value) -> &str {
    body["error"]["code"].as_str().unwrap_or_default()
}

pub async fn seed_org(pool: &PgPool, slug_prefix: &str) -> Uuid {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'M4 Waterfall')")
        .bind(org)
        .bind(format!("{slug_prefix}-{}", &org.simple().to_string()[..10]))
        .execute(pool)
        .await
        .unwrap();
    go_live::go_live(pool, org).await;
    org
}

pub async fn seed_unit_and_branch(pool: &PgPool, org: Uuid, unit_name: &str) -> (Uuid, Uuid) {
    let region: Uuid = sqlx::query_scalar(
        "INSERT INTO regions (org_id, name) VALUES ($1, 'Region Main') RETURNING id",
    )
    .bind(org)
    .fetch_one(pool)
    .await
    .unwrap();
    let branch: Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, 'Branch Main', $2) RETURNING id",
    )
    .bind(region)
    .bind(org)
    .fetch_one(pool)
    .await
    .unwrap();
    let unit = Uuid::new_v4();
    sqlx::query("INSERT INTO org_units (org_id, id) VALUES ($1, $2)")
        .bind(org)
        .bind(unit)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO org_unit_revisions \
         (org_id, org_unit_id, version, command_id, actor_id, payload_digest, attributes, receipt) \
         SELECT $1, $2, 1, gen_random_uuid(), u.id, decode(repeat('00', 32), 'hex'), \
                jsonb_build_object('name', $3::text, 'kind', 'department', 'status', 'ACTIVE'), '{}'::jsonb \
         FROM users u WHERE u.org_id = $1 LIMIT 1",
    )
    .bind(org)
    .bind(unit)
    .bind(unit_name)
    .execute(pool)
    .await
    .unwrap();
    (branch, unit)
}

pub async fn seed_employee(
    pool: &PgPool,
    org: Uuid,
    branch: Uuid,
    unit: Uuid,
    name: &str,
    number: &str,
    row_num: i32,
) -> Uuid {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE console_leave_definer")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO employees \
         (org_id, company, name, employee_number, home_branch_id, org_unit_id, hire_date, \
          employment_status, source_filename, source_sheet, source_row, source_key) \
         VALUES ($1, 'Co', $2, $3, $4, $5, '2025-01-02', 'ACTIVE', 'seed', 'seed', $6, $7) \
         RETURNING id",
    )
    .bind(org)
    .bind(name)
    .bind(number)
    .bind(branch)
    .bind(unit)
    .bind(row_num)
    .bind(Uuid::new_v4().to_string())
    .fetch_one(tx.as_mut())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    id
}

pub async fn grant_tenant_pay_view(pool: &PgPool, org: Uuid, actor: UserId) {
    let granter = harness::user(pool, org, "SUPER_ADMIN").await;
    let role = Uuid::new_v4();
    sqlx::query("INSERT INTO access_roles (org_id, id, name_ko, status, version, created_by) VALUES ($1, $2, 'PayView', 'ACTIVE', 1, $3)")
        .bind(org).bind(role).bind(granter.as_uuid()).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions (org_id, role_id, version, name_ko, status, change_mode, created_by) VALUES ($1, $2, 1, 'PayView', 'ACTIVE', 'SETUP', $3)")
        .bind(org).bind(role).bind(granter.as_uuid()).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines (org_id, role_id, version, domain, levels) VALUES ($1, $2, 1, 'pay', ARRAY['view'])")
        .bind(org).bind(role).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_grants (org_id, account_id, role_id, scope_kind, valid_from, effective_in_setup, change_mode, reason_code, granted_by) VALUES ($1, $2, $3, 'TENANT', now() - interval '1 day', true, 'SETUP', 'TEST', $4)")
        .bind(org).bind(actor.as_uuid()).bind(role).bind(granter.as_uuid()).execute(pool).await.unwrap();
}
