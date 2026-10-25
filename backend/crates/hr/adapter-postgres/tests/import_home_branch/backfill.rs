// SPDX-License-Identifier: LicenseRef-Proprietary
use sqlx::PgPool;
use uuid::Uuid;

use super::shared::{seed_placement, setup_headquarters};
use crate::harness::importer;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn test_backfill_idempotent_sets_home_branch_for_live_assignment_and_null_home_branch(
    pool: PgPool,
) {
    // Exercise the rollout across tenants with and without a selected migration tenant.
    let first = importer(pool.clone()).await;
    let second = importer(pool).await;
    let mut fixtures = Vec::new();
    for i in [&first, &second] {
        let default_branch = i.f.branch;
        let (entity, workplace) = setup_headquarters(i, default_branch).await;
        let o = i.org();

        // Create an active employee and an exited employee directly with NULL home_branch_id
        let active_emp = Uuid::new_v4();
        let exited_emp = Uuid::new_v4();
        let mut tx = i.owner.begin().await.unwrap();
        sqlx::query("SET LOCAL session_replication_role = replica")
            .execute(tx.as_mut())
            .await
            .unwrap();
        sqlx::query(
        "INSERT INTO employees (id, org_id, company, name, employee_number, source_filename, source_sheet, source_row, source_key, employment_status, home_branch_id) \
         VALUES ($1, $2, '주식회사 한빛', '기존재직', 'E-301', 'legacy.xlsx', 'Sheet1', 1, 'k-301', 'ACTIVE', NULL), \
                ($3, $2, '주식회사 한빛', '기존퇴사', 'E-302', 'legacy.xlsx', 'Sheet1', 2, 'k-302', 'EXITED', NULL)",
    )
    .bind(active_emp)
    .bind(o)
    .bind(exited_emp)
    .execute(tx.as_mut())
    .await
    .unwrap();

        // Add live assignments for both
        sqlx::query(
        "INSERT INTO employment_assignments (id, org_id, employee_id, legal_entity_id, workplace_id, valid_from, valid_to, superseded_at, cause, command_id, actor_id) \
         VALUES (gen_random_uuid(), $1, $2, $3, $4, '2024-01-01', NULL, NULL, 'HIRE', gen_random_uuid(), $5), \
                (gen_random_uuid(), $1, $6, $3, $4, '2024-01-01', NULL, NULL, 'HIRE', gen_random_uuid(), $5)",
    )
    .bind(o)
    .bind(active_emp)
    .bind(entity)
    .bind(workplace)
    .bind(*i.f.principal.user_id.as_uuid())
    .bind(exited_emp)
    .execute(tx.as_mut())
    .await
    .unwrap();
        tx.commit().await.unwrap();

        fixtures.push((i, active_emp, exited_emp));
    }

    // Neither serving role may use the maintenance writer, even with a tenant selected.
    for role in ["console_rt", "console_leave_cmd"] {
        let mut tx = first.owner.begin().await.unwrap();
        sqlx::query(sqlx::AssertSqlSafe(format!("SET LOCAL ROLE {role}")))
            .execute(tx.as_mut())
            .await
            .unwrap();
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(first.org().to_string())
            .execute(tx.as_mut())
            .await
            .unwrap();
        let error = sqlx::query_scalar::<_, i64>("SELECT hr_api.backfill_placement_home_branch()")
            .fetch_one(tx.as_mut())
            .await
            .expect_err("serving roles must not change routing through the backfill");
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("42501"),
        );
        tx.rollback().await.unwrap();
    }

    // Execute the exact rollout, with all writer guards and RLS enabled.
    let migration = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../platform/db/migrations/20261025130000000_placement_home_branch_routing.sql"
    ))
    .unwrap();
    let rollout = format!("DO $${}", migration.split_once("\nDO $$").unwrap().1);
    let mut timestamps = Vec::new();
    for (run, previous_org) in [String::new(), first.org().to_string()]
        .into_iter()
        .enumerate()
    {
        let mut tx = first.owner.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(&previous_org)
            .execute(tx.as_mut())
            .await
            .unwrap();
        sqlx::raw_sql(sqlx::AssertSqlSafe(rollout.clone()))
            .execute(tx.as_mut())
            .await
            .unwrap();
        let org: String = sqlx::query_scalar("SELECT current_setting('app.current_org', true)")
            .fetch_one(tx.as_mut())
            .await
            .unwrap();
        assert_eq!(org, previous_org, "rollout must restore the tenant context");
        tx.commit().await.unwrap();

        for (index, (i, active_emp, exited_emp)) in fixtures.iter().enumerate() {
            let (branch, updated_at): (Option<Uuid>, time::OffsetDateTime) = sqlx::query_as(
                "SELECT home_branch_id, updated_at FROM employees WHERE org_id = $1 AND id = $2",
            )
            .bind(i.org())
            .bind(active_emp)
            .fetch_one(&i.owner)
            .await
            .unwrap();
            assert_eq!(branch, Some(i.f.branch));
            if run == 0 {
                timestamps.push(updated_at);
            } else {
                assert_eq!(updated_at, timestamps[index], "rerun must not write again");
            }
            let exited_branch: Option<Uuid> = sqlx::query_scalar(
                "SELECT home_branch_id FROM employees WHERE org_id = $1 AND id = $2",
            )
            .bind(i.org())
            .bind(exited_emp)
            .fetch_one(&i.owner)
            .await
            .unwrap();
            assert_eq!(
                exited_branch, None,
                "exited employee must remain unmodified"
            );
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn test_backfill_routes_only_live_placements_at_open_branches_and_audits_each(pool: PgPool) {
    let i = importer(pool).await;
    let open = setup_headquarters(&i, i.f.branch).await;
    let closed_branch: Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id, deactivated_at) \
         SELECT region_id, '폐쇄', org_id, now() FROM branches WHERE id = $1 RETURNING id",
    )
    .bind(i.f.branch)
    .fetch_one(&i.owner)
    .await
    .unwrap();
    let closed = setup_headquarters(&i, closed_branch).await;

    let mut cases = Vec::new();
    for (key, place, span, superseded, routed) in [
        ("오늘-시작", open, (0, None), false, true),
        ("내일-종료", open, (-5, Some(1)), false, true),
        ("내일-시작", open, (1, None), false, false),
        ("오늘-종료", open, (-5, Some(0)), false, false),
        ("취소됨", open, (-5, None), true, false),
        ("폐쇄-지점", closed, (-5, None), false, false),
    ] {
        let employee = seed_placement(&i, place, key, span, superseded).await;
        cases.push((key, employee, routed));
    }

    let mut tx = i.owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(i.org().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let first: i64 = sqlx::query_scalar("SELECT hr_api.backfill_placement_home_branch()")
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
    let second: i64 = sqlx::query_scalar("SELECT hr_api.backfill_placement_home_branch()")
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!((first, second), (2, 0), "repairs are counted once");

    for (key, employee, routed) in cases {
        let branch: Option<Uuid> = sqlx::query_scalar(
            "SELECT home_branch_id FROM employees WHERE org_id = $1 AND id = $2",
        )
        .bind(i.org())
        .bind(employee)
        .fetch_one(&i.owner)
        .await
        .unwrap();
        assert_eq!(branch, routed.then_some(i.f.branch), "{key}");
        let audits: Vec<(Option<Uuid>, Option<Uuid>, serde_json::Value)> = sqlx::query_as(
            "SELECT actor, branch_id, after_snap FROM audit_events \
             WHERE org_id = $1 AND action = 'employee.home_branch_set' AND target_id = $2",
        )
        .bind(i.org())
        .bind(employee.to_string())
        .fetch_all(&i.owner)
        .await
        .unwrap();
        if routed {
            assert_eq!(audits.len(), 1, "{key}: one routing audit per repair");
            let (actor, branch, after) = &audits[0];
            assert_eq!(*actor, None, "{key}: the system repair has no actor");
            assert_eq!(*branch, Some(i.f.branch), "{key}");
            assert_eq!(after["reason"], "placement_backfill", "{key}");
        } else {
            assert!(audits.is_empty(), "{key}: untouched rows are not audited");
        }
    }
}
