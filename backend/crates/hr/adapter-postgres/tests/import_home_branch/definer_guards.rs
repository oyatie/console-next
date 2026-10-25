// SPDX-License-Identifier: LicenseRef-Proprietary
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn test_placement_home_branch_definers_pin_temp_schema_last(pool: PgPool) {
    for name in [
        "leave_api.follow_assignment_branch()",
        "hr_api.backfill_placement_home_branch()",
        "hr_api.route_placement_home_branch(uuid,uuid)",
    ] {
        let config: Vec<String> = sqlx::query_scalar(
            "SELECT proconfig FROM pg_proc \
             WHERE oid = to_regprocedure($1)",
        )
        .bind(name)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(
            config
                .iter()
                .any(|s| s == "search_path=pg_catalog, pg_temp"),
            "{name} must resolve catalog objects before temporary objects: {config:?}"
        );
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn test_placement_home_branch_definers_require_tenant_context(pool: PgPool) {
    // Outside any tenant the trigger no longer routes privileged writers;
    // inside a different tenant it refuses.
    for (tenant, refused) in [(String::new(), false), (Uuid::new_v4().to_string(), true)] {
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(tenant)
            .execute(tx.as_mut())
            .await
            .unwrap();
        // Isolate the definer's own check from assignment constraints and RLS.
        sqlx::raw_sql(
            "CREATE TEMP TABLE placement_probe AS \
             SELECT * FROM public.employment_assignments WITH NO DATA; \
             CREATE TRIGGER placement_probe_home_branch AFTER INSERT ON placement_probe \
             FOR EACH ROW EXECUTE FUNCTION leave_api.follow_assignment_branch()",
        )
        .execute(tx.as_mut())
        .await
        .unwrap();
        let inserted = sqlx::query("INSERT INTO placement_probe (org_id) VALUES ($1)")
            .bind(Uuid::new_v4())
            .execute(tx.as_mut())
            .await;
        if refused {
            let error = inserted.expect_err("the trigger must reject a mismatched tenant");
            assert_eq!(
                error.as_database_error().unwrap().code().as_deref(),
                Some("42501")
            );
        } else {
            inserted.expect("no tenant context: nothing is routed and the insert stands");
        }
        tx.rollback().await.unwrap();
    }

    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', '', true)")
        .execute(tx.as_mut())
        .await
        .unwrap();
    let error = sqlx::query("SELECT hr_api.backfill_placement_home_branch()")
        .execute(tx.as_mut())
        .await
        .expect_err("the backfill must reject missing tenant context");
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("42501")
    );
    tx.rollback().await.unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn routing_itself_rejects_a_different_tenant(pool: PgPool) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(Uuid::new_v4().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let error = sqlx::query("SELECT hr_api.route_placement_home_branch($1,$2)")
        .bind(Uuid::new_v4())
        .bind(Uuid::new_v4())
        .execute(tx.as_mut())
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("42501")
    );
    tx.rollback().await.unwrap();
}
