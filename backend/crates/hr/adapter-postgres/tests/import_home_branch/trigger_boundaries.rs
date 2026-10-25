// SPDX-License-Identifier: LicenseRef-Proprietary
use sqlx::PgPool;
use uuid::Uuid;

use super::shared::{seed_placement, setup_headquarters};
use crate::harness::importer;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn due_runner_routes_a_newly_current_placement_once(pool: PgPool) {
    let i = importer(pool).await;
    let place = setup_headquarters(&i, i.f.branch).await;
    let employee = seed_placement(&i, place, "due-placement", (1, None), false).await;
    let today = console_hr_adapter_postgres::clock::today_kst();
    i.f.hr.apply_due(today).await.unwrap();
    let branch: Option<Uuid> =
        sqlx::query_scalar("SELECT home_branch_id FROM employees WHERE id=$1")
            .bind(employee)
            .fetch_one(&i.owner)
            .await
            .unwrap();
    assert_eq!(branch, None, "future placements do not route early");
    let mut tx = i.owner.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE employment_assignments SET valid_from=entity_today() WHERE employee_id=$1")
        .bind(employee)
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    for _ in 0..2 {
        i.f.hr.apply_due(today).await.unwrap();
    }
    let branch: Option<Uuid> =
        sqlx::query_scalar("SELECT home_branch_id FROM employees WHERE id=$1")
            .bind(employee)
            .fetch_one(&i.owner)
            .await
            .unwrap();
    assert_eq!(branch, Some(i.f.branch));
    let audits: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE target_id=$1 AND action='employee.home_branch_set'")
        .bind(employee.to_string()).fetch_one(&i.owner).await.unwrap();
    assert_eq!(audits, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn test_trigger_routes_only_live_placements_at_open_branches_and_audits_once(pool: PgPool) {
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

    for (key, place, span, superseded, routed) in [
        ("오늘-시작", open, (0, None), false, true),
        ("내일-종료", open, (-5, Some(1)), false, true),
        ("내일-시작", open, (1, None), false, false),
        ("오늘-종료", open, (-5, Some(0)), false, false),
        ("취소됨", open, (-5, None), true, false),
        ("폐쇄-지점", closed, (-5, None), false, false),
        (
            "사업장-없음",
            (open.0, Uuid::new_v4()),
            (-5, None),
            false,
            false,
        ),
    ] {
        let employee = seed_placement(&i, place, key, span, superseded).await;
        let mut tx = i.owner.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(i.org().to_string())
            .execute(tx.as_mut())
            .await
            .unwrap();
        // Isolate the real trigger from assignment constraints and replay the same event.
        sqlx::raw_sql(
            "CREATE TEMP TABLE placement_probe AS \
             SELECT * FROM public.employment_assignments WITH NO DATA; \
             CREATE TRIGGER placement_probe_home_branch AFTER INSERT ON placement_probe \
             FOR EACH ROW EXECUTE FUNCTION leave_api.follow_assignment_branch()",
        )
        .execute(tx.as_mut())
        .await
        .unwrap();
        let mut previous: (Option<Uuid>, time::OffsetDateTime) = sqlx::query_as(
            "SELECT home_branch_id, updated_at FROM employees WHERE org_id = $1 AND id = $2",
        )
        .bind(i.org())
        .bind(employee)
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
        assert_eq!(previous.0, None, "{key}: fixture starts without routing");
        for delivery in 0..2 {
            sqlx::query(
                "INSERT INTO placement_probe SELECT * FROM public.employment_assignments \
                 WHERE org_id = $1 AND employee_id = $2",
            )
            .bind(i.org())
            .bind(employee)
            .execute(tx.as_mut())
            .await
            .unwrap();
            let stamp: (Option<Uuid>, time::OffsetDateTime) = sqlx::query_as(
                "SELECT home_branch_id, updated_at FROM employees WHERE org_id = $1 AND id = $2",
            )
            .bind(i.org())
            .bind(employee)
            .fetch_one(tx.as_mut())
            .await
            .unwrap();
            assert_eq!(stamp.0, routed.then_some(i.f.branch), "{key}");
            if !routed || delivery > 0 {
                assert_eq!(stamp, previous, "{key}: skipped events must not write");
            }
            let audits: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM audit_events WHERE org_id = $1 AND target_id = $2 \
                 AND action = 'employee.home_branch_set'",
            )
            .bind(i.org())
            .bind(employee.to_string())
            .fetch_one(tx.as_mut())
            .await
            .unwrap();
            assert_eq!(audits, i64::from(routed), "{key}: audit only once");
            previous = stamp;
        }
        tx.rollback().await.unwrap();
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn routing_does_not_preempt_an_import_context_without_snapshots(pool: PgPool) {
    let i = importer(pool).await;
    let place = setup_headquarters(&i, i.f.branch).await;
    let employee = seed_placement(&i, place, "import-context", (0, None), false).await;
    let mut tx = i.owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true), set_config('app.employee_import_run',$2,true)")
        .bind(i.org().to_string()).bind(Uuid::new_v4().to_string()).execute(tx.as_mut()).await.unwrap();
    let branch: Option<Uuid> =
        sqlx::query_scalar("SELECT hr_api.route_placement_home_branch($1,$2)")
            .bind(i.org())
            .bind(employee)
            .fetch_one(tx.as_mut())
            .await
            .unwrap();
    assert_eq!(
        branch, None,
        "settle must record the routing inverse itself"
    );
    let branch: Option<Uuid> =
        sqlx::query_scalar("SELECT home_branch_id FROM employees WHERE id=$1")
            .bind(employee)
            .fetch_one(tx.as_mut())
            .await
            .unwrap();
    assert_eq!(branch, None);
    tx.rollback().await.unwrap();
}
