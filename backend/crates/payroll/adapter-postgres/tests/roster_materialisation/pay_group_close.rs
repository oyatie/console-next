// SPDX-License-Identifier: LicenseRef-Proprietary
//! An open pay-group run follows People at the close preflight, without saving,
//! and at attendance close; a 법인 with several pay groups, or a run that is not
//! regular, gets no roster from membership.
use super::pay_group::{JUNE, MONTHLY, member, single_group_run};
use super::places::*;
use super::seed::*;
use console_payroll_adapter_postgres::lifecycle::{calculate_run_in_tx, submit_run_in_tx};
use sqlx::PgPool;

fn lines(keys: &[(&str, &str)]) -> Vec<(String, String)> {
    keys.iter()
        .map(|(key, status)| ((*key).to_owned(), (*status).to_owned()))
        .collect()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_close_preflight_counts_a_member_hired_after_creation_and_persists_nothing(
    pool: PgPool,
) {
    let (f, le, site) = single_group_run(&pool, "REGULAR").await;
    member(&pool, &f, "emp-1", (le, site)).await;
    seed_import(
        &pool,
        f.org,
        "APPLIED",
        "CANDIDATE",
        JUNE,
        "emp-1",
        attendance_row(),
    )
    .await;
    materialise_for(&pool, &f, JUNE).await;
    let created = statuses(&pool, f.run).await;
    // Recorded after the run was created, with no attendance yet.
    member(&pool, &f, "joiner", (le, site)).await;
    lock_period(&pool, f.org, JUNE).await;
    let verdict = preflight(&pool, &f).await;
    assert_eq!(
        (
            verdict.can_close,
            verdict.checks[0].note.clone(),
            statuses(&pool, f.run).await
        ),
        (false, Some("근태 원천 누락 1명".to_owned()), created)
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn attendance_close_adds_a_member_hired_after_creation(pool: PgPool) {
    let (f, le, site) = single_group_run(&pool, "REGULAR").await;
    member(&pool, &f, "emp-1", (le, site)).await;
    seed_import(
        &pool,
        f.org,
        "APPLIED",
        "CANDIDATE",
        JUNE,
        "emp-1",
        attendance_row(),
    )
    .await;
    materialise_for(&pool, &f, JUNE).await;
    member(&pool, &f, "joiner", (le, site)).await;
    seed_import(
        &pool,
        f.org,
        "APPLIED",
        "CANDIDATE",
        JUNE,
        "joiner",
        attendance_row(),
    )
    .await;
    lock_period(&pool, f.org, JUNE).await;
    let closed = close(&pool, &f).await;
    assert_eq!(
        (closed, roster(&pool, &f).await),
        (
            Ok(()),
            vec![("emp-1".to_owned(), 0, 1), ("joiner".to_owned(), 0, 1)]
        )
    );
}

/// An exit before the period, recorded after the run was created, takes the
/// person off the roster as a VOID line, so their missing attendance no longer
/// holds the close.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_late_recorded_exit_before_the_period_voids_the_line_and_stops_blocking_close(
    pool: PgPool,
) {
    let (f, le, site) = single_group_run(&pool, "REGULAR").await;
    member(&pool, &f, "emp-1", (le, site)).await;
    seed_import(
        &pool,
        f.org,
        "APPLIED",
        "CANDIDATE",
        JUNE,
        "emp-1",
        attendance_row(),
    )
    .await;
    let leaver = member(&pool, &f, "leaver", (le, site)).await;
    materialise_for(&pool, &f, JUNE).await;
    sqlx::query(
        "UPDATE employees SET employment_status='EXITED', exit_on=DATE '2026-05-20' WHERE id=$1",
    )
    .bind(leaver)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE employment_assignments SET valid_to=DATE '2026-05-21' WHERE employee_id=$1",
    )
    .bind(leaver)
    .execute(&pool)
    .await
    .unwrap();
    lock_period(&pool, f.org, JUNE).await;
    let closed = close(&pool, &f).await;
    assert_eq!(
        (closed, statuses(&pool, f.run).await),
        (
            Ok(()),
            lines(&[("emp-1", "BLOCKED_LEGAL_GATE"), ("leaver", "VOID")])
        )
    );
}

/// Calculation leaves a retracted person's VOID line alone and does not count it,
/// and a run in which no line could be calculated has no pay to submit.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_void_line_stays_void_through_calculation_and_nothing_calculated_cannot_be_submitted(
    pool: PgPool,
) {
    let (f, le, site) = single_group_run(&pool, "REGULAR").await;
    member(&pool, &f, "emp-1", (le, site)).await;
    seed_import(
        &pool,
        f.org,
        "APPLIED",
        "CANDIDATE",
        JUNE,
        "emp-1",
        attendance_row(),
    )
    .await;
    let leaver = member(&pool, &f, "leaver", (le, site)).await;
    materialise_for(&pool, &f, JUNE).await;
    sqlx::query(
        "UPDATE employment_assignments SET valid_to=DATE '2026-05-21' WHERE employee_id=$1",
    )
    .bind(leaver)
    .execute(&pool)
    .await
    .unwrap();
    lock_period(&pool, f.org, JUNE).await;
    close(&pool, &f).await.unwrap();
    let actor = user(&pool, f.org).await;
    let mut tx = pool.begin().await.unwrap();
    let blocked = calculate_run_in_tx(&mut tx, f.run)
        .await
        .unwrap()
        .blocked_lines;
    let submitted = submit_run_in_tx(&mut tx, f.run, actor).await;
    tx.commit().await.unwrap();
    assert_eq!(
        (
            blocked,
            statuses(&pool, f.run).await,
            submitted.map_err(|error| error.to_string())
        ),
        (
            1,
            lines(&[("emp-1", "BLOCKED_LEGAL_GATE"), ("leaver", "VOID")]),
            Err("no line of this run has a calculation, so there is nothing to submit".to_owned())
        )
    );
}

/// A registration void holds the person while it destroys their details. A
/// roster written meanwhile waits for it and leaves the voided person off,
/// rather than copying the destroyed name onto a line.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_person_voided_while_the_roster_is_written_is_left_off(pool: PgPool) {
    let (f, le, site) = single_group_run(&pool, "REGULAR").await;
    member(&pool, &f, "kept", (le, site)).await;
    let voided = member(&pool, &f, "voided", (le, site)).await;
    let voider = user(&pool, f.org).await;
    let mut void = pool.begin().await.unwrap();
    sqlx::query("SELECT 1 FROM employees WHERE id=$1 FOR UPDATE")
        .bind(voided)
        .execute(&mut *void)
        .await
        .unwrap();
    sqlx::query("UPDATE employees SET employment_status='VOIDED',voided_at=now(),voided_by=$2,void_reason_code='MISTAKE',void_mode='SETUP' WHERE id=$1")
        .bind(voided).bind(voider).execute(&mut *void).await.unwrap();
    let writer = tokio::spawn({
        let (pool, f) = (
            pool.clone(),
            Fixture {
                org: f.org,
                run: f.run,
            },
        );
        async move { materialise_for(&pool, &f, JUNE).await }
    });
    // The void commits once the writer waits on a row lock, or has finished
    // without ever waiting.
    let waiting = "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND datname=current_database()) FROM pg_sleep(0.02)";
    while !writer.is_finished()
        && !sqlx::query_scalar::<_, bool>(waiting)
            .fetch_one(&pool)
            .await
            .unwrap()
    {}
    void.commit().await.unwrap();
    writer.await.unwrap();
    assert_eq!(
        statuses(&pool, f.run).await,
        lines(&[("kept", "BLOCKED_LEGAL_GATE")])
    );
}

/// Once the 법인 has a second pay group, who belongs to which is unknown: an open
/// run keeps the lines it has and nobody is added or removed.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_second_pay_group_on_the_legal_entity_freezes_an_open_runs_roster(pool: PgPool) {
    let (f, le, site) = single_group_run(&pool, "REGULAR").await;
    member(&pool, &f, "emp-1", (le, site)).await;
    seed_import(
        &pool,
        f.org,
        "APPLIED",
        "CANDIDATE",
        JUNE,
        "emp-1",
        attendance_row(),
    )
    .await;
    materialise_for(&pool, &f, JUNE).await;
    pay_group(&pool, f.org, le, MONTHLY).await;
    member(&pool, &f, "joiner", (le, site)).await;
    seed_import(
        &pool,
        f.org,
        "APPLIED",
        "CANDIDATE",
        JUNE,
        "joiner",
        attendance_row(),
    )
    .await;
    let written = materialise_for(&pool, &f, JUNE).await;
    assert_eq!(
        (written, statuses(&pool, f.run).await),
        (0, lines(&[("emp-1", "BLOCKED_LEGAL_GATE")]))
    );
}

/// Off-cycle, correction and exit-settlement runs name their own people; the
/// group's membership, or an import for the period, adds nobody to them.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn only_regular_runs_get_a_roster(pool: PgPool) {
    let (f, le, site) = single_group_run(&pool, "OFF_CYCLE").await;
    member(&pool, &f, "emp-1", (le, site)).await;
    seed_import(
        &pool,
        f.org,
        "APPLIED",
        "CANDIDATE",
        JUNE,
        "emp-1",
        attendance_row(),
    )
    .await;
    let written = materialise_for(&pool, &f, JUNE).await;
    assert_eq!((written, statuses(&pool, f.run).await), (0, lines(&[])));
}
