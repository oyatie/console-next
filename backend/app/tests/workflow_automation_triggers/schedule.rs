// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn schedule_poller_starts_due_run_exactly_once_under_concurrent_poll(owner_pool: PgPool) {
    let org = OrgId::from_uuid(SCHEDULE_TENANT);
    let author = seed_org_and_author(&owner_pool, org, "org-auto-schedule").await;
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let definition_id = seed_graph_definition(&rt_pool, org, "automation.daily").await;
    let now = OffsetDateTime::now_utc();
    // Due one minute ago, at whole-second precision so the value round-trips
    // Postgres' microsecond timestamptz exactly.
    let due_fire = OffsetDateTime::from_unix_timestamp(now.unix_timestamp() - 60).unwrap();
    let schedule_id = seed_schedule(&rt_pool, org, definition_id, author, due_fire).await;
    let store = PgWorkflowRuntimeStore::new(rt_pool.clone());

    // Two pollers race on the same due fire (the concurrent-poll idempotency
    // claim: deterministic run key + guarded advance).
    let (a, b) = tokio::join!(poll_org(&store, org, now), poll_org(&store, org, now));
    let started = a.unwrap() + b.unwrap();
    assert_eq!(started, 1, "concurrent polls must start exactly one run");
    assert_eq!(
        count(&rt_pool, org, "SELECT count(*) FROM workflow_runs").await,
        1
    );

    // The run carries schedule provenance and the reserved SCHEDULE trigger.
    let mut tx = rt_pool.begin().await.unwrap();
    arm_org(&mut tx, org).await;
    let run = sqlx::query(
        "SELECT status, trigger_type, schedule_id, idempotency_key, initiated_by \
         FROM workflow_runs",
    )
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(run.get::<String, _>("status"), "SUCCEEDED");
    assert_eq!(run.get::<String, _>("trigger_type"), "SCHEDULE");
    assert_eq!(run.get::<Option<Uuid>, _>("schedule_id"), Some(schedule_id));
    assert_eq!(
        run.get::<String, _>("idempotency_key"),
        format!("schedule:{schedule_id}:{}", due_fire.unix_timestamp())
    );
    assert_eq!(
        run.get::<Option<Uuid>, _>("initiated_by"),
        None,
        "system fire has no actor"
    );

    // The schedule advanced exactly once: next_run_at strictly in the future
    // (next 09:00 KST after now), last_run_at = the claimed fire.
    let schedule = sqlx::query(
        "SELECT next_run_at, last_run_at, last_status FROM workflow_schedules WHERE id = $1",
    )
    .bind(schedule_id)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let next: Option<OffsetDateTime> = schedule.get("next_run_at");
    assert!(
        next.unwrap() > now,
        "next_run_at must advance into the future"
    );
    assert_eq!(
        schedule.get::<Option<OffsetDateTime>, _>("last_run_at"),
        Some(due_fire)
    );
    let last_status: Option<String> = schedule.get("last_status");
    let (before, after): (serde_json::Value, serde_json::Value) = sqlx::query_as("SELECT before_snap,after_snap FROM audit_events WHERE action='workflow_schedule.advance' AND target_id=$1")
        .bind(schedule_id.to_string()).fetch_one(&owner_pool).await.unwrap();
    for wire in [
        &before["next_run_at"],
        &after["next_run_at"],
        &after["last_run_at"],
    ] {
        let wire = wire.as_str().unwrap();
        assert!(wire.ends_with('Z'), "{wire}");
        OffsetDateTime::parse(wire, &time::format_description::well_known::Rfc3339).unwrap();
    }

    assert!(
        matches!(last_status.as_deref(), Some("STARTED") | Some("SKIPPED")),
        "last_status records the racing pollers' outcome, got {last_status:?}"
    );
    tx.commit().await.unwrap();

    // Nothing is due any more: a follow-up poll starts nothing and adds no rows.
    let again = poll_org(&store, org, OffsetDateTime::now_utc())
        .await
        .unwrap();
    assert_eq!(again, 0);
    assert_eq!(
        count(&rt_pool, org, "SELECT count(*) FROM workflow_runs").await,
        1
    );
}
