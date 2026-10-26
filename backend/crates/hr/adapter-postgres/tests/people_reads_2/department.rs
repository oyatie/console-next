// SPDX-License-Identifier: LicenseRef-Proprietary
//! The department review and bulk selection share one set-based filter at roster scale.
use super::fixtures::{fixture, site};
use super::support::{employee, principal, query, tenant, user};
use console_hr_adapter_postgres::directory::read_filters::{
    EmployeeListFilters, counted_employees,
};
use console_hr_adapter_postgres::lifecycle::bulk_selection::{BulkSelection, resolve_selection};
use console_kernel_core::{BranchScope, OrgId};
use console_platform_test_support::runtime_role_pool;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn department_filter_and_selection_share_one_department_set_at_scale(pool: PgPool) {
    let t = tenant(&pool).await;
    let actor = user(&pool, t.org, None).await;
    let dept = site(&pool, t.org, *actor.as_uuid(), "Department").await;
    let site = site(&pool, t.org, *actor.as_uuid(), "Site").await;
    fixture(&pool,"UPDATE org_unit_revisions SET attributes = attributes || '{\"kind\":\"department\"}' WHERE org_id=$1 AND org_unit_id=$2",t.org,&[dept]).await;
    fixture(&pool,"INSERT INTO employees (org_id,name,company,employment_status,org_unit_id,source_filename,source_sheet,source_row,source_key) SELECT $1,'Person ' || n,'Test',CASE WHEN n=2 THEN 'ON_LEAVE' ELSE 'ACTIVE' END,CASE WHEN n % 3 = 0 THEN $2 WHEN n % 3 = 1 THEN $3 END,'fixture.xlsx','Roster',n,'scale-' || n FROM generate_series(1,2000) n",t.org,&[dept,site]).await;
    employee(&pool, t.org, "Later", "D", "PRE_HIRE").await;
    employee(&pool, t.org, "Exited", "E", "EXITED").await;
    let merged = employee(&pool, t.org, "Merged", "M", "ACTIVE").await;
    fixture(&pool, "UPDATE employees SET merged_into_employee_id=(SELECT id FROM employees WHERE org_id=$1 AND source_key='scale-3') WHERE org_id=$1 AND id=$2", t.org, &[merged]).await;
    let foreign = tenant(&pool).await;
    let foreign_actor = user(&pool, foreign.org, None).await;
    let foreign_dept = super::fixtures::site(
        &pool,
        foreign.org,
        *foreign_actor.as_uuid(),
        "Foreign department",
    )
    .await;
    fixture(&pool, "UPDATE org_unit_revisions SET attributes=attributes || '{\"kind\":\"department\"}' WHERE org_id=$1 AND org_unit_id=$2", foreign.org, &[foreign_dept]).await;
    employee(&pool, foreign.org, "Foreign", "F", "ACTIVE").await;
    let missing =
        t.hr.list_employees(
            principal(t.org, actor),
            query(json!({"department_missing":true})),
        )
        .await
        .unwrap();
    assert_eq!(missing.total, 1334);
    let facets =
        t.hr.employee_facets(
            principal(t.org, actor),
            query(json!({"department_missing": true})),
        )
        .await
        .unwrap();
    assert_eq!(facets.total, missing.total);
    assert_eq!(
        serde_json::to_value(&facets.review).unwrap()["department_missing"],
        1334
    );
    let complement =
        t.hr.employee_facets(
            principal(t.org, actor),
            query(json!({"department_missing": false})),
        )
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(&complement.review).unwrap()["department_missing"],
        1334,
        "review facets lift their own filter"
    );
    let placed =
        t.hr.list_employees(
            principal(t.org, actor),
            query(json!({"department_missing":false})),
        )
        .await
        .unwrap();
    assert_eq!(placed.total, 669);
    let runtime = runtime_role_pool(&pool).await;
    let unscoped: Vec<Uuid> = sqlx::query_scalar("SELECT department_unit_ids()")
        .fetch_all(&runtime)
        .await
        .unwrap();
    assert!(
        unscoped.is_empty(),
        "a connection without a tenant sees no departments"
    );
    console_platform_db::with_org_conn(&runtime,OrgId::from_uuid(t.org),|tx| Box::pin(async move {
        let units: Vec<Uuid> = sqlx::query_scalar("SELECT department_unit_ids()").fetch_all(tx.as_mut()).await.unwrap();
        assert_eq!(units, [dept], "the department set must exclude other tenants");
        let filters = EmployeeListFilters::from_query(&query(json!({"department_missing":true})),&BranchScope::All).unwrap();
        let expected: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM employees WHERE merged_into_employee_id IS NULL AND org_unit_id IS DISTINCT FROM $1 AND entity_employed_on(entity_today(),hire_on,exit_on,employment_status) ORDER BY id").bind(dept).fetch_all(tx.as_mut()).await.unwrap();
        let selection = |expected_count| BulkSelection { query: query(json!({"department_missing":true})), exclude_employee_ids: vec![], expected_count };
        assert_eq!(resolve_selection(tx,&selection(1334),&BranchScope::All).await.unwrap(),expected);
        let changed = resolve_selection(tx,&selection(1333),&BranchScope::All).await.unwrap_err();
        assert_eq!((changed.status.as_u16(),changed.code),(409,"bulk_selection_changed"));
        let mut explain = counted_employees("EXPLAIN (ANALYZE, VERBOSE, FORMAT JSON) SELECT e.id",&filters);
        let plan: Value = explain.build_query_scalar().fetch_one(tx.as_mut()).await.unwrap();
        fn check_once(plan: &Value) -> usize {
            let mut count = 0;
            if plan["Output"].as_array().is_some_and(|output| output.iter().any(|value| value.as_str().is_some_and(|s| s.contains("department_unit_ids()")))) {
                assert_eq!(plan["Actual Loops"],1,"department set must be read once: {plan}"); count += 1;
            }
            if let Some(children) = plan["Plans"].as_array() { for child in children { count += check_once(child); } }
            count
        }
        assert!(check_once(&plan[0]["Plan"]) > 0,"{plan}");
        Ok::<_,console_hr_adapter_postgres::HrError>(())
    })).await.unwrap();
}
