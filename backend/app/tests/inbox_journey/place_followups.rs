// SPDX-License-Identifier: LicenseRef-Proprietary
//! Placement gaps and named register gaps through the runtime HTTP router.

use super::*;

#[path = "placement_setup.rs"]
mod setup;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn effective_exit_dates_keep_unplaced_counts_and_people_consistent(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    let mut current = BTreeSet::new();
    for (name, status, exit_offset) in [
        ("퇴직당일", "EXITED", 0_i32),
        ("퇴직예정", "EXITED", 1),
        ("퇴직완료", "ACTIVE", -1),
    ] {
        let employee = followup_person(&pool, org, name).await;
        sqlx::query("UPDATE employees SET hire_date=(entity_today()-10)::text,exit_date=(entity_today()+$4)::text,employment_status=$3 WHERE org_id=$1 AND id=$2")
            .bind(org).bind(employee).bind(status).bind(exit_offset)
            .execute(&pool).await.unwrap();
        if exit_offset >= 0 {
            current.insert(employee.to_string());
        }
    }

    let (status, facets) = ctx
        .call(
            "GET",
            "/api/v1/employees/facets?status=ACTIVE,ON_LEAVE,UNKNOWN,PRE_HIRE",
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{facets}");
    assert_eq!(
        facets["review"]["home_branch_review_required"], 2,
        "{facets}"
    );
    let (status, queue) = ctx
        .call("GET", "/api/v1/employees/import/unplaced", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{queue}");
    assert_eq!(queue["count"], 2, "{queue}");
    let queued: BTreeSet<_> = queue["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["employee_id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(queued, current, "{queue}");

    let page = inbox(&ctx).await;
    let rows = items_of(&page, "unplaced");
    assert_eq!(rows.len(), 2, "{page}");
    let shown: BTreeSet<_> = rows
        .iter()
        .map(|row| row["links"][0]["id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(shown, current, "{page}");
    assert!(
        rows.iter().all(|row| row["context"]["review_count"] == 2),
        "{page}"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_upcoming_hire_is_unplaced_on_home_and_the_roster_until_the_assignment_starts(
    pool: PgPool,
) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    let employee = followup_person(&pool, org, "입사예정").await;
    sqlx::query("UPDATE employees SET employment_status='PRE_HIRE',hire_date=(entity_today()+1)::text WHERE org_id=$1 AND id=$2")
        .bind(org).bind(employee).execute(&pool).await.unwrap();
    let (status, facets) = ctx
        .call("GET", "/api/v1/employees/facets?status=PRE_HIRE", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{facets}");
    assert_eq!(facets["review"]["home_branch_review_required"], 1);
    let (status, queue) = ctx
        .call("GET", "/api/v1/employees/import/unplaced", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{queue}");
    assert_eq!(queue["count"], 1);
    let page = inbox(&ctx).await;
    let rows: Vec<_> = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["kind"] == "unplaced" || item["kind"] == "home_branch_review")
        .collect();
    assert_eq!(
        rows.len(),
        1,
        "the Home count must include this upcoming hire: {page}"
    );
    assert_eq!(rows[0]["links"][0]["id"], employee.to_string());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn placed_people_with_null_routing_copies_do_not_emit_unplaced_followups(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    let (entity, workplace, _, site_unit) = http::structure(&ctx).await;
    let mut placed = Vec::new();
    for name in ["배치1", "배치2", "배치3"] {
        placed.push(followup_person(&pool, org, name).await);
    }
    let missing = followup_person(&pool, org, "미배치").await;
    sqlx::query("UPDATE employees SET worksite_name='본사' WHERE org_id=$1 AND id=$2")
        .bind(org)
        .bind(missing)
        .execute(&pool)
        .await
        .unwrap();
    let today = console_hr_domain::text::parse_yyyy_mm_dd(&http::today_kst()).unwrap();
    let mut tx = pool.begin().await.unwrap();
    // Reproduce imports that predate routing: the placement exists, the copied branch does not.
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE employees SET org_unit_id=$1 WHERE org_id=$2 AND id=ANY($3)")
        .bind(Uuid::parse_str(&site_unit).unwrap())
        .bind(org)
        .bind(&placed)
        .execute(tx.as_mut())
        .await
        .unwrap();
    for employee in &placed {
        sqlx::query("INSERT INTO employment_assignments (org_id,employee_id,legal_entity_id,workplace_id,valid_from,cause,command_id) VALUES ($1,$2,$3,$4,$5,'MIGRATION',gen_random_uuid())")
            .bind(org).bind(employee).bind(Uuid::parse_str(&entity).unwrap())
            .bind(Uuid::parse_str(&workplace).unwrap()).bind(today - Duration::days(1))
            .execute(tx.as_mut()).await.unwrap();
    }
    tx.commit().await.unwrap();
    let null_copies: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM employees WHERE org_id=$1 AND id=ANY($2) AND home_branch_id IS NULL",
    )
    .bind(org)
    .bind(&placed)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        null_copies, 3,
        "the regression fixture must retain missing routing copies"
    );

    let (status, facets) = ctx
        .call("GET", "/api/v1/employees/facets?status=ACTIVE", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{facets}");
    assert_eq!(
        facets["review"]["home_branch_review_required"], 1,
        "{facets}"
    );
    let (status, queue) = ctx
        .call("GET", "/api/v1/employees/import/unplaced", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{queue}");
    assert_eq!(queue["count"], 1, "{queue}");
    assert_eq!(queue["items"][0]["employee_id"], missing.to_string());

    let page = inbox(&ctx).await;
    let rows = items_of(&page, "unplaced");
    assert_eq!(rows.len(), 1, "{page}");
    assert_eq!(rows[0]["id"], format!("hr_unplaced:{missing}"));
    assert_eq!(rows[0]["title"], "업무함-미배치");
    assert_eq!(rows[0]["context"]["review_count"], 1);
    assert!(
        rows[0]["site"].is_null(),
        "a physical worksite is not a statutory placement"
    );
    assert_eq!(rows[0]["context"]["worksite_name"], "본사");
    for row in items_of(&page, "register_review")
        .into_iter()
        .filter(|row| row["id"] != format!("hr_register:{missing}"))
    {
        assert_eq!(row["site"], "주식회사 가나 › 본사");
    }
    assert!(items_of(&page, "home_branch_review").is_empty(), "{page}");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn register_followups_name_only_missing_facts_and_omit_complete_records(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    let (entity, workplace, _, _) = http::structure(&ctx).await;
    let entity = Uuid::parse_str(&entity).unwrap();
    let workplace = Uuid::parse_str(&workplace).unwrap();
    let today = console_hr_domain::text::parse_yyyy_mm_dd(&http::today_kst()).unwrap();
    for (name, day) in [("배치법인", today), ("미래법인", today + Duration::days(1))] {
        sqlx::query("INSERT INTO legal_entity_revisions (org_id,legal_entity_id,version,command_id,effective_from,name,change_mode,reason_code,payload_digest,settings_snapshot) SELECT $1,$2,COALESCE(max(version),0)+1,gen_random_uuid(),$3,$4,'MIGRATION','TEST',sha256('place'::bytea),'{}' FROM legal_entity_revisions WHERE org_id=$1 AND legal_entity_id=$2")
            .bind(org).bind(entity).bind(day).bind(name)
            .execute(&pool).await.unwrap();
    }
    let (status, department) = ctx
        .call(
            "POST",
            "/api/v1/org-structure/units",
            Some(json!({"name":"개발본부", "workplace_id":workplace})),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{department}");
    let department: Uuid = sqlx::query_scalar("SELECT org_unit_id FROM org_unit_revisions WHERE org_id=$1 AND attributes->>'name'='개발본부' ORDER BY version DESC LIMIT 1")
        .bind(org).fetch_one(&pool).await.unwrap();
    let complete = followup_person(&pool, org, "명부완료").await;
    let incomplete = followup_person(&pool, org, "명부항목빠짐").await;
    sqlx::query(
        "UPDATE employees SET worksite_name='고객 사무실',org_unit_id=$3 WHERE org_id=$1 AND id=$2",
    )
    .bind(org)
    .bind(incomplete)
    .bind(department)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO employment_assignments (org_id,employee_id,legal_entity_id,workplace_id,valid_from,cause,command_id) VALUES ($1,$2,$3,$4,$5,'MIGRATION',gen_random_uuid())")
        .bind(org).bind(incomplete).bind(entity).bind(workplace).bind(today - Duration::days(1))
        .execute(&pool).await.unwrap();
    sqlx::query(
        "UPDATE employees SET birth_date='1990-01-02',job='개발' WHERE org_id=$1 AND id=$2",
    )
    .bind(org)
    .bind(complete)
    .execute(&pool)
    .await
    .unwrap();
    let address: Uuid = sqlx::query_scalar("INSERT INTO employee_addresses (org_id,employee_id,source,road_addr_part1,si_nm,created_by) VALUES ($1,$2,'MANUAL_UNVERIFIED','서울특별시 강남구 테헤란로 152','서울특별시',$3) RETURNING id")
        .bind(org).bind(complete).bind(user.as_uuid()).fetch_one(&pool).await.unwrap();
    sqlx::query("INSERT INTO employee_register_facts (org_id,employee_id,sex,address_id,career_none) VALUES ($1,$2,'MALE',$3,true)")
        .bind(org).bind(complete).bind(address).execute(&pool).await.unwrap();

    let page = inbox(&ctx).await;
    let rows = items_of(&page, "register_review");
    assert_eq!(rows.len(), 1, "{page}");
    assert_eq!(rows[0]["id"], format!("hr_register:{incomplete}"));
    assert_eq!(rows[0]["site"], "배치법인 › 본사 › 개발본부");
    assert_eq!(rows[0]["context"]["worksite_name"], "고객 사무실");
    assert_eq!(rows[0]["context"]["review_count"], 1);
    assert_eq!(
        rows[0]["context"]["register"]["missing_fields"],
        json!(["birth", "job", "sex", "address", "career"])
    );
}
