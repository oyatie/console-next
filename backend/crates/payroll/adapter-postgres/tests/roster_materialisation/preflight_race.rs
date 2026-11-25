// SPDX-License-Identifier: LicenseRef-Proprietary
//! A line committed while the close preflight waited for the run is a saved line.
use super::pay_group::{JUNE, member, single_group_run};
use super::places::{materialise_for, preflight};
use super::seed::{Fixture, attendance_row, seed_import};
use console_payroll_adapter_postgres::roster::materialise_roster_in_tx;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_preflight_links_a_line_committed_while_it_waited_for_the_run(pool: PgPool) {
    let (f, le, site) = single_group_run(&pool, "REGULAR").await;
    member(&pool, &f, "emp-a", (le, site)).await;
    seed_import(
        &pool,
        f.org,
        "APPLIED",
        "CANDIDATE",
        JUNE,
        "emp-a",
        attendance_row(),
    )
    .await;
    assert_eq!(materialise_for(&pool, &f, JUNE).await, 1);
    // A joiner with no attendance.
    member(&pool, &f, "joiner", (le, site)).await;
    // A roster write holds the run lock and has written the joiner's line, not yet committed.
    let mut stage = pool.begin().await.unwrap();
    assert_eq!(
        materialise_roster_in_tx(&mut stage, f.org, f.run, JUNE.0, JUNE.1)
            .await
            .unwrap(),
        2
    );
    let read = tokio::spawn({
        let (pool, f) = (
            pool.clone(),
            Fixture {
                org: f.org,
                run: f.run,
            },
        );
        async move { preflight(&pool, &f).await }
    });
    let waiting = "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND datname=current_database()) FROM pg_sleep(0.01)";
    while !read.is_finished()
        && !sqlx::query_scalar::<_, bool>(waiting)
            .fetch_one(&pool)
            .await
            .unwrap()
    {}
    stage.commit().await.unwrap();
    let verdict = read.await.unwrap();
    let joiner: Uuid = sqlx::query_scalar(
        "SELECT id FROM payroll_draft_lines WHERE run_id = $1 AND employee_source_key = 'joiner'",
    )
    .bind(f.run)
    .fetch_one(&pool)
    .await
    .unwrap();
    let attendance = verdict
        .checks
        .iter()
        .find(|c| c.key == "attendance_material")
        .unwrap();
    let counted = attendance.note.as_deref().map(|note| {
        note.chars()
            .filter(char::is_ascii_digit)
            .collect::<String>()
    });
    assert_eq!(
        (counted, attendance.blocking_refs.clone()),
        (Some("1".to_owned()), vec![joiner])
    );
}
