// SPDX-License-Identifier: LicenseRef-Proprietary
//! Setup and queue agreement for optional departments and upcoming hires.
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn setup_queue_and_home_agree_on_departments_and_future_first_placements(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    let (entity, workplace, _, _) = http::structure(&ctx).await;
    let department_gap = followup_person(&pool, org, "부서미정").await;
    let future_placed = followup_person(&pool, org, "입사예정배치").await;
    let future_unplaced = followup_person(&pool, org, "입사예정미배치").await;
    sqlx::query("UPDATE employees SET source_metadata=jsonb_build_object('unresolved_org_unit','개발부') WHERE org_id=$1 AND id=$2")
        .bind(org).bind(department_gap).execute(&pool).await.unwrap();
    sqlx::query("UPDATE employees SET employment_status='PRE_HIRE',hire_date=(entity_today()+5)::text WHERE org_id=$1 AND id=ANY($2)")
        .bind(org).bind(vec![future_placed,future_unplaced]).execute(&pool).await.unwrap();
    for (employee, offset) in [(department_gap, -1_i32), (future_placed, 5)] {
        sqlx::query("INSERT INTO employment_assignments (org_id,employee_id,legal_entity_id,workplace_id,valid_from,cause,command_id) VALUES ($1,$2,$3,$4,entity_today()+$5,'MIGRATION',gen_random_uuid())")
            .bind(org).bind(employee).bind(Uuid::parse_str(&entity).unwrap())
            .bind(Uuid::parse_str(&workplace).unwrap()).bind(offset).execute(&pool).await.unwrap();
    }
    let (status, queue) = ctx
        .call("GET", "/api/v1/employees/import/unplaced", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{queue}");
    assert_eq!(
        queue["count"], 2,
        "workplace and department gaps share one bulk remedy: {queue}"
    );
    assert_eq!(
        queue["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|p| p["reason"] == "unit_unknown")
            .count(),
        1
    );
    let (status, setup) = ctx.call("GET", "/api/v1/onboarding/checklist", None).await;
    assert_eq!(status, StatusCode::OK, "{setup}");
    assert_eq!(setup["summary"]["unplaced"], 1, "{setup}");
    let page = inbox(&ctx).await;
    let rows = items_of(&page, "unplaced");
    assert_eq!(rows.len(), 1, "{page}");
    assert_eq!(rows[0]["links"][0]["id"], future_unplaced.to_string());
    let (status, list) = ctx
        .call("GET", "/api/v1/employees?status=PRE_HIRE", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let row = list["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == future_placed.to_string())
        .unwrap();
    assert_eq!(row["workplace_id"], workplace);
    assert_eq!(row["home_branch_review_required"], false, "{row}");
    let (status, preview) = ctx
        .call("GET", "/api/v1/onboarding/go-live/preview", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    let blocker = preview["blockers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["code"] == "people_without_department")
        .expect("setup department gaps have a named blocker");
    assert_eq!(blocker["count"], 1);
    assert_eq!(blocker["remedy"], "assign_department");
    assert_eq!(blocker["records"][0]["id"], department_gap.to_string());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_unresolved_department_keeps_its_bulk_remedy_without_inflating_unplaced(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    let (entity, workplace, _, _) = http::structure(&ctx).await;
    let employee = followup_person(&pool, org, "부서없음").await;
    sqlx::query("UPDATE employees SET source_metadata=jsonb_build_object('unresolved_org_unit','개발부') WHERE org_id=$1 AND id=$2")
        .bind(org).bind(employee).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO employment_assignments (org_id,employee_id,legal_entity_id,workplace_id,valid_from,cause,command_id) VALUES ($1,$2,$3,$4,entity_today()-1,'MIGRATION',gen_random_uuid())")
        .bind(org).bind(employee).bind(Uuid::parse_str(&entity).unwrap())
        .bind(Uuid::parse_str(&workplace).unwrap()).execute(&pool).await.unwrap();
    let (status, queue) = ctx
        .call("GET", "/api/v1/employees/import/unplaced", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{queue}");
    assert_eq!(queue["count"], 1, "{queue}");
    assert_eq!(queue["items"][0]["employee_id"], employee.to_string());
    assert_eq!(queue["items"][0]["reason"], "unit_unknown");
    let (status, setup) = ctx.call("GET", "/api/v1/onboarding/checklist", None).await;
    assert_eq!(status, StatusCode::OK, "{setup}");
    assert_eq!(setup["summary"]["unplaced"], 0, "{setup}");
    let (status, facets) = ctx.call("GET", "/api/v1/employees/facets", None).await;
    assert_eq!(status, StatusCode::OK, "{facets}");
    assert_eq!(facets["review"]["home_branch_review_required"], 0);
    assert!(items_of(&inbox(&ctx).await, "unplaced").is_empty());
    let employees = setup["steps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["key"] == "employees")
        .unwrap();
    assert_eq!(employees["state"], "attention");
    assert_eq!(employees["remedy"], "assign_departments");
}
