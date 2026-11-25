// SPDX-License-Identifier: LicenseRef-Proprietary
//! A legal entity with a second pay group no longer defines who an open regular
//! run of the first one pays: the run keeps its lines, and attendance close is
//! refused for that cause instead of attesting a roster nobody can confirm.
use super::pay_group::{JUNE, MONTHLY, member, single_group_run};
use super::places::*;
use super::seed::*;
use console_payroll_adapter_postgres::lifecycle::ClosePreflight;
use sqlx::PgPool;

const AMBIGUOUS: &str = "pay_group_roster_ambiguous";

/// The attendance check's verdict, note and fix-links, and whether the run may close.
fn attendance(verdict: &ClosePreflight) -> (bool, bool, Option<String>, usize) {
    let check = &verdict.checks[0];
    (
        verdict.can_close,
        check.ok,
        check.note.clone(),
        check.blocking_refs.len(),
    )
}

/// The close refusal names the cause, or the close went through.
fn refused_for(closed: Result<(), String>, cause: &str) -> Result<(), bool> {
    closed.map_err(|error| error.contains(cause))
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_second_pay_group_freezes_an_open_runs_roster_and_refuses_its_close(pool: PgPool) {
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
    lock_period(&pool, f.org, JUNE).await;
    let verdict = preflight(&pool, &f).await;
    let closed = close(&pool, &f).await;
    assert_eq!(
        (
            written,
            statuses(&pool, f.run).await,
            attendance(&verdict),
            refused_for(closed, AMBIGUOUS)
        ),
        (
            0,
            vec![("emp-1".to_owned(), "BLOCKED_LEGAL_GATE".to_owned())],
            (false, false, Some(AMBIGUOUS.to_owned()), 0),
            Err(true)
        )
    );
}

/// A run is created before its period's attendance is applied, so only the
/// close's refresh brings that attendance onto the lines.
async fn close_after_late_attendance(pool: &PgPool, second_group: bool) -> CloseOutcome {
    let (f, le, site) = single_group_run(pool, "REGULAR").await;
    member(pool, &f, "emp-1", (le, site)).await;
    materialise_for(pool, &f, JUNE).await;
    if second_group {
        pay_group(pool, f.org, le, MONTHLY).await;
    }
    seed_import(
        pool,
        f.org,
        "APPLIED",
        "CANDIDATE",
        JUNE,
        "emp-1",
        attendance_row(),
    )
    .await;
    lock_period(pool, f.org, JUNE).await;
    let verdict = attendance(&preflight(pool, &f).await);
    let closed = refused_for(close(pool, &f).await, AMBIGUOUS);
    (verdict, closed, roster(pool, &f).await)
}

type CloseOutcome = (
    (bool, bool, Option<String>, usize),
    Result<(), bool>,
    Vec<(String, i32, i32)>,
);

/// Once a second pay group makes the roster unknown, the refresh writes nothing,
/// so the close is refused for that cause, not for the attendance it never loaded.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_run_whose_legal_entity_gained_a_pay_group_is_refused_for_that_cause(pool: PgPool) {
    assert_eq!(
        close_after_late_attendance(&pool, true).await,
        (
            (false, false, Some(AMBIGUOUS.to_owned()), 0),
            Err(true),
            vec![("emp-1".to_owned(), 0, 0)]
        )
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_run_of_a_legal_entitys_only_pay_group_closes_on_attendance_applied_later(pool: PgPool) {
    assert_eq!(
        close_after_late_attendance(&pool, false).await,
        (
            (true, true, None, 0),
            Ok(()),
            vec![("emp-1".to_owned(), 0, 1)]
        )
    );
}
