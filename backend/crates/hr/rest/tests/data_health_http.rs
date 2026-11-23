// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::too_many_arguments
)]
//! HTTP integration verification for `GET /api/v1/hr/people/data-health`:
//! cross-tenant isolation, 403 Cedar refusal, branch-scope confinement,
//! `EmployeeDirectoryManage`-gated `latest_import`, zero-PII output, and category parity.

use axum::{
    Extension, Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use console_hr_adapter_postgres::HrService;
use console_hr_rest::data_health::router;
use console_kernel_core::{BranchId, BranchScope, OrgId};
use console_platform_authz::{Principal, Role};
use console_platform_test_support::{
    runtime_role_pool, seed_active_user, seed_org_and_super_admin,
};
use serde_json::Value;
use sqlx::PgPool;
use std::collections::BTreeSet;
use tower::ServiceExt;
use uuid::Uuid;

fn app(hr: HrService, principal: Principal) -> Router {
    router(hr).layer(Extension(principal))
}

async fn get_health(app: Router, uri: &str) -> (StatusCode, Value) {
    let response = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let raw = String::from_utf8_lossy(&bytes);
    assert!(!raw.contains("SensitiveName"), "PII leaked: {raw}");
    assert!(!raw.contains("1991-04-12"), "Birth date leaked: {raw}");
    assert!(!raw.contains("910412-1"), "RRN leaked: {raw}");
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn seed_branch(pool: &PgPool, org: Uuid, region: Uuid, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO branches (id, region_id, name, org_id) VALUES ($1, $2, $3, $4)")
        .bind(id)
        .bind(region)
        .bind(name)
        .bind(org)
        .execute(pool)
        .await
        .unwrap();
    id
}

async fn seed_employee(
    pool: &PgPool,
    org: Uuid,
    emp_no: &str,
    status: &str,
    id_type: Option<&str>,
    home_branch: Option<Uuid>,
    birth: Option<&str>,
    hire: &str,
) -> Uuid {
    let id = Uuid::new_v4();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO employees (id, org_id, company, name, employee_number, employment_status, \
         id_type, home_branch_id, birth_date, hire_date, hire_on, source_filename, source_sheet, \
         source_row, source_key, raw_row, source_metadata) \
         VALUES ($1,$2,'TestCo','SensitiveName',$3,$4,$5,$6,$7::date,$8,$8::date,'seed.xlsx','S1',1,$9,'{}','{}')",
    )
    .bind(id)
    .bind(org)
    .bind(emp_no)
    .bind(status)
    .bind(id_type)
    .bind(home_branch)
    .bind(birth)
    .bind(hire)
    .bind(format!("k-{id}"))
    .execute(tx.as_mut())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    id
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn data_health_enforces_tenant_cedar_branch_zero_pii_and_category_parity(pool: PgPool) {
    let org_a = OrgId::from_uuid(Uuid::new_v4());
    let org_b = OrgId::from_uuid(Uuid::new_v4());
    let super_a = seed_org_and_super_admin(&pool, *org_a.as_uuid(), "dh-a").await;
    sqlx::query("UPDATE users SET is_tenant_ops = true WHERE id = $1")
        .bind(super_a.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let super_b = seed_org_and_super_admin(&pool, *org_b.as_uuid(), "dh-b").await;

    let region = Uuid::new_v4();
    sqlx::query("INSERT INTO regions (id, name, org_id) VALUES ($1, 'Seoul', $2)")
        .bind(region)
        .bind(org_a.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let branch_1 = seed_branch(&pool, *org_a.as_uuid(), region, "B1").await;
    let branch_2 = seed_branch(&pool, *org_a.as_uuid(), region, "B2").await;

    // Seed Org A cohort: 1 ACTIVE in branch_1 (incomplete register + bank flag), 1 PRE_HIRE NOT_ISSUED in branch_2
    let e1 = seed_employee(
        &pool,
        *org_a.as_uuid(),
        "A-01",
        "ACTIVE",
        Some("RRN"),
        Some(branch_1),
        Some("1991-04-12"),
        "2025-01-01",
    )
    .await;
    let e2 = seed_employee(
        &pool,
        *org_a.as_uuid(),
        "A-02",
        "PRE_HIRE",
        Some("NOT_ISSUED"),
        Some(branch_2),
        None,
        "2029-01-01",
    )
    .await;
    // Exited employee excluded from active cohort
    seed_employee(
        &pool,
        *org_a.as_uuid(),
        "A-03",
        "EXITED",
        Some("RRN"),
        Some(branch_1),
        None,
        "2024-01-01",
    )
    .await;

    sqlx::query(
        "INSERT INTO employee_personal_facts (org_id, employee_id, bank_account_registered) \
         VALUES ($1, $2, true)",
    )
    .bind(org_a.as_uuid())
    .bind(e1)
    .execute(&pool)
    .await
    .unwrap();

    // Seed an import run so latest_import verifies EmployeeDirectoryManage gating
    sqlx::query(
        "INSERT INTO data_import_runs (org_id, id, entity_type, source_filename, source_format, source_sha256, status, input_rows, candidate_rows, preserved_rows, created_by) \
         VALUES ($1, gen_random_uuid(), 'employee_hr', 'h.xlsx', 'xlsx', repeat('a', 64), 'DRY_RUN', 2, 2, 0, $2)",
    )
    .bind(org_a.as_uuid())
    .bind(super_a.as_uuid())
    .execute(&pool)
    .await
    .unwrap();

    let hr = HrService::new(runtime_role_pool(&pool).await);
    let p_super_a = Principal::new(
        super_a,
        org_a,
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    );
    let (status, body) = get_health(
        app(hr.clone(), p_super_a.clone()),
        "/api/v1/hr/people/data-health",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["cohort"]["total"], 2);
    assert_eq!(body["cohort"]["active"], 1);
    assert_eq!(body["cohort"]["pre_hire"], 1);
    assert_eq!(body["id_summary"]["not_issued"], 1);
    assert_eq!(body["id_summary"]["by_type"]["rrn"], 1);
    assert_eq!(body["id_summary"]["by_type"]["not_issued"], 1);
    assert_eq!(body["bank_account"]["registered"], 1);
    assert_eq!(body["bank_account"]["missing"], 1);
    assert_eq!(
        body["statutory_register"]["missing_by_category"]["birth"],
        1
    );
    assert_eq!(body["statutory_register"]["incomplete_count"], 2);
    assert!(body["latest_import"].is_object());
    assert_eq!(body["drilldown_items"].as_array().unwrap().len(), 2);

    // Filter category=birth + limit=1 returns only e2 (missing birth)
    let (s_cat, b_cat) = get_health(
        app(hr.clone(), p_super_a),
        "/api/v1/hr/people/data-health?category=birth&limit=1",
    )
    .await;
    assert_eq!(s_cat, StatusCode::OK);
    let items = b_cat["drilldown_items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["employee_id"], e2.to_string());

    // Invalid category returns 422
    let p_super_a2 = Principal::new(
        super_a,
        org_a,
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    );
    let (s_bad, _) = get_health(
        app(hr.clone(), p_super_a2),
        "/api/v1/hr/people/data-health?category=invalid_cat",
    )
    .await;
    assert_eq!(s_bad, StatusCode::UNPROCESSABLE_ENTITY);

    // Cross-tenant isolation: Org B sees zero Org A employees or imports
    let p_super_b = Principal::new(
        super_b,
        org_b,
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    );
    let (s_b, b_b) = get_health(app(hr.clone(), p_super_b), "/api/v1/hr/people/data-health").await;
    assert_eq!(s_b, StatusCode::OK);
    assert_eq!(b_b["cohort"]["total"], 0);
    assert!(b_b["latest_import"].is_null());

    // Branch-scoped confinement: sees only branch_1 (1 employee: e1)
    let branch_admin = seed_active_user(&pool, *org_a.as_uuid(), "ADMIN", "dh-branch").await;
    let p_branch = Principal::new(
        branch_admin,
        org_a,
        BTreeSet::from([Role::Admin]),
        BranchScope::Branches(BTreeSet::from([BranchId::from_uuid(branch_1)])),
    );
    let (s_br, b_br) = get_health(app(hr.clone(), p_branch), "/api/v1/hr/people/data-health").await;
    assert_eq!(s_br, StatusCode::OK);
    assert_eq!(b_br["cohort"]["total"], 1);
    assert_eq!(b_br["drilldown_items"][0]["employee_id"], e1.to_string());

    // Member without EmployeeDirectoryRead receives 403 forbidden
    let member = seed_active_user(&pool, *org_a.as_uuid(), "MEMBER", "dh-member").await;
    let p_member = Principal::new(
        member,
        org_a,
        BTreeSet::from([Role::Member]),
        BranchScope::All,
    );
    let (s_mem, _) = get_health(app(hr.clone(), p_member), "/api/v1/hr/people/data-health").await;
    assert_eq!(s_mem, StatusCode::FORBIDDEN);

    // Executive with Cedar read-only grant (hr_basic: ['view'], is_tenant_ops = false)
    // receives 200 with latest_import == null (EmployeeDirectoryManage is NOT granted)
    let exec_ro = seed_active_user(&pool, *org_a.as_uuid(), "EXECUTIVE", "dh-exec").await;
    let role_id: Uuid = sqlx::query_scalar(
        "INSERT INTO access_roles(org_id, name_ko, status, version, created_by) \
         VALUES($1, 'Directory ReadOnly', 'ACTIVE', 1, $2) RETURNING id",
    )
    .bind(org_a.as_uuid())
    .bind(super_a.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO access_role_versions(org_id, role_id, version, name_ko, status, change_mode, created_by) \
         VALUES($1, $2, 1, 'Directory ReadOnly', 'ACTIVE', 'SETUP', $3)",
    )
    .bind(org_a.as_uuid())
    .bind(role_id)
    .bind(super_a.as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO access_role_lines(org_id, role_id, version, domain, levels) VALUES($1, $2, 1, 'hr_basic', ARRAY['view'])",
    )
    .bind(org_a.as_uuid())
    .bind(role_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO access_grants(org_id, account_id, role_id, scope_kind, valid_from, change_mode, reason_code, granted_by, effective_in_setup) \
         VALUES($1, $2, $3, 'TENANT', now() - interval '1 day', 'SETUP', 'TEST', $4, true)",
    )
    .bind(org_a.as_uuid())
    .bind(exec_ro.as_uuid())
    .bind(role_id)
    .bind(super_a.as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    let p_ro = Principal::new(
        exec_ro,
        org_a,
        BTreeSet::from([Role::Executive]),
        BranchScope::All,
    );
    let (s_ro, b_ro) = get_health(app(hr, p_ro), "/api/v1/hr/people/data-health").await;
    assert_eq!(s_ro, StatusCode::OK, "{b_ro}");
    assert!(b_ro["latest_import"].is_null());

    let audit_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id = $1 AND action = 'employee.list_read' AND after_snap->>'surface' = 'data_health'",
    )
    .bind(org_a.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(audit_count >= 1);
}
