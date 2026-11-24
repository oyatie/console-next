// SPDX-License-Identifier: LicenseRef-Proprietary
//! Each line records the 법인, 사업장 and department in force at the run's period
//! end, while the run is open and once more at attendance close; nothing rewrites
//! a line after that.
use super::places::*;
use super::seed::*;
use sqlx::PgPool;
use time::macros::date;
use uuid::Uuid;

async fn imported(pool: &PgPool, f: &Fixture, key: &str, unit: Option<Uuid>) -> Uuid {
    let id = active(pool, f.org, key, unit).await;
    let period = (PERIOD_START, PERIOD_END);
    seed_import(
        pool,
        f.org,
        "APPLIED",
        "CANDIDATE",
        period,
        key,
        attendance_row(),
    )
    .await;
    id
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_line_records_the_entity_workplace_and_department_in_force_at_the_period_end(
    pool: PgPool,
) {
    let f = seed_org_and_run(&pool).await;
    let (le, team) = (entity(&pool, f.org).await, unit(&pool, f.org).await);
    let (site, next) = (
        workplace(&pool, f.org, le).await,
        workplace(&pool, f.org, le).await,
    );
    let person = imported(&pool, &f, "emp-1", Some(team)).await;
    assign(&pool, f.org, person, Some((le, site)), (LONG_AGO, None)).await;
    // Near miss: a move that starts the day after the period ends.
    transfer(&pool, f.org, person, (le, next), date!(2026 - 07 - 01)).await;
    materialise(&pool, &f).await;
    assert_eq!(
        placements(&pool, f.run).await,
        [placed("emp-1", le, site, Some(team))]
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_transfer_inside_the_period_records_the_last_workplace(pool: PgPool) {
    let f = seed_org_and_run(&pool).await;
    let le = entity(&pool, f.org).await;
    let (first, last) = (
        workplace(&pool, f.org, le).await,
        workplace(&pool, f.org, le).await,
    );
    let person = imported(&pool, &f, "emp-1", None).await;
    assign(&pool, f.org, person, Some((le, first)), (LONG_AGO, None)).await;
    transfer(&pool, f.org, person, (le, last), date!(2026 - 06 - 15)).await;
    materialise(&pool, &f).await;
    assert_eq!(
        placements(&pool, f.run).await,
        [placed("emp-1", le, last, None)]
    );
}

/// A person paid in the period after leaving before it keeps the 법인 and 사업장
/// they left from, and the line prints that 법인's name rather than
/// UNKNOWN_COMPANY.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_leaver_keeps_the_entity_and_workplace_they_left_from_and_its_name(pool: PgPool) {
    let f = seed_org_and_run(&pool).await;
    let le = named_entity(&pool, f.org, "주식회사 가나테크").await;
    let site = workplace(&pool, f.org, le).await;
    let span = (None, Some(date!(2026 - 05 - 19)));
    let leaver = person(&pool, f.org, "emp-1", None, "EXITED", span).await;
    let worked = (LONG_AGO, Some(date!(2026 - 05 - 20)));
    assign(&pool, f.org, leaver, Some((le, site)), worked).await;
    let period = (PERIOD_START, PERIOD_END);
    seed_import(
        &pool,
        f.org,
        "APPLIED",
        "CANDIDATE",
        period,
        "emp-1",
        attendance_row(),
    )
    .await;
    materialise(&pool, &f).await;
    let company: String =
        sqlx::query_scalar("SELECT employee_company FROM payroll_draft_lines WHERE run_id = $1")
            .bind(f.run)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        (placements(&pool, f.run).await, company),
        (
            vec![placed("emp-1", le, site, None)],
            "주식회사 가나테크".to_owned()
        )
    );
}

/// A department move effective after the period end does not reach the line: it
/// keeps the department the move left.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_department_move_applied_after_the_period_keeps_the_period_department(pool: PgPool) {
    let f = seed_org_and_run(&pool).await;
    let le = entity(&pool, f.org).await;
    let site = workplace(&pool, f.org, le).await;
    let [before, during, after] = [
        unit(&pool, f.org).await,
        unit(&pool, f.org).await,
        unit(&pool, f.org).await,
    ];
    let person = imported(&pool, &f, "emp-1", Some(after)).await;
    assign(&pool, f.org, person, Some((le, site)), (LONG_AGO, None)).await;
    // Near miss: a move inside the period is already the period's department.
    department_move(
        &pool,
        f.org,
        person,
        (before, during),
        date!(2026 - 06 - 10),
    )
    .await;
    department_move(&pool, f.org, person, (during, after), date!(2026 - 07 - 01)).await;
    materialise(&pool, &f).await;
    assert_eq!(
        placements(&pool, f.run).await,
        [placed("emp-1", le, site, Some(during))]
    );
}

/// An import shows the person was paid in the period even when every assignment
/// on record starts later (a start date filled in from when the record was
/// created), so the line takes the earliest one rather than no placement.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_imported_line_whose_assignments_all_start_later_takes_the_earliest(pool: PgPool) {
    let f = seed_org_and_run(&pool).await;
    let le = entity(&pool, f.org).await;
    let (first, later) = (
        workplace(&pool, f.org, le).await,
        workplace(&pool, f.org, le).await,
    );
    let person = imported(&pool, &f, "emp-1", None).await;
    let recorded = date!(2026 - 08 - 01);
    assign(&pool, f.org, person, Some((le, first)), (recorded, None)).await;
    transfer(&pool, f.org, person, (le, later), date!(2026 - 09 - 01)).await;
    materialise(&pool, &f).await;
    assert_eq!(
        placements(&pool, f.run).await,
        [placed("emp-1", le, first, None)]
    );
}

/// A placed line whose assignment is later withdrawn loses its 법인, and with it
/// the 법인 name it printed: the name and the id never disagree.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_line_that_loses_its_placement_drops_the_entity_name(pool: PgPool) {
    let f = seed_org_and_run(&pool).await;
    let le = named_entity(&pool, f.org, "주식회사 가나테크").await;
    let site = workplace(&pool, f.org, le).await;
    let person = imported(&pool, &f, "emp-1", None).await;
    assign(&pool, f.org, person, Some((le, site)), (LONG_AGO, None)).await;
    materialise(&pool, &f).await;
    let staged = placed_and_named(&pool, f.run).await;
    sqlx::query("UPDATE employment_assignments SET superseded_at=now() WHERE employee_id=$1")
        .bind(person)
        .execute(&pool)
        .await
        .unwrap();
    lock_period(&pool, f.org, (PERIOD_START, PERIOD_END)).await;
    close(&pool, &f).await.unwrap();
    assert_eq!(
        (staged, placed_and_named(&pool, f.run).await),
        (
            (
                vec![placed("emp-1", le, site, None)],
                "주식회사 가나테크".to_owned()
            ),
            (
                vec![("emp-1".to_owned(), None, None, None)],
                "UNKNOWN_COMPANY".to_owned()
            )
        )
    );
}

async fn placed_and_named(pool: &PgPool, run: Uuid) -> (Vec<Placed>, String) {
    let company =
        sqlx::query_scalar("SELECT employee_company FROM payroll_draft_lines WHERE run_id = $1")
            .bind(run)
            .fetch_one(pool)
            .await
            .unwrap();
    (placements(pool, run).await, company)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn re_materialising_a_closed_run_writes_nothing(pool: PgPool) {
    let f = seed_org_and_run(&pool).await;
    let le = entity(&pool, f.org).await;
    let (site, other) = (
        workplace(&pool, f.org, le).await,
        workplace(&pool, f.org, le).await,
    );
    let person = imported(&pool, &f, "emp-1", None).await;
    assign(&pool, f.org, person, Some((le, site)), (LONG_AGO, None)).await;
    materialise(&pool, &f).await;
    lock_period(&pool, f.org, (PERIOD_START, PERIOD_END)).await;
    close(&pool, &f).await.unwrap();
    // A source row verified after close: re-staging must not reset it.
    sqlx::query(
        "UPDATE payroll_draft_lines SET nts_tax_row_status='VERIFIED_SOURCE_ROW' WHERE run_id=$1",
    )
    .bind(f.run)
    .execute(&pool)
    .await
    .unwrap();
    let at_close = verified_state(&pool, f.run).await;
    let late = imported(&pool, &f, "emp-2", None).await;
    assign(&pool, f.org, late, Some((le, site)), (LONG_AGO, None)).await;
    transfer(&pool, f.org, person, (le, other), date!(2026 - 06 - 10)).await;
    let written = materialise(&pool, &f).await;
    assert_eq!((written, verified_state(&pool, f.run).await), (0, at_close));
}

async fn verified_state(pool: &PgPool, run: Uuid) -> Vec<(String, String, Option<Uuid>)> {
    sqlx::query_as("SELECT employee_source_key, nts_tax_row_status, (to_jsonb(l)->>'workplace_id')::uuid FROM payroll_draft_lines l WHERE run_id=$1 ORDER BY 1")
        .bind(run).fetch_all(pool).await.unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn attendance_close_records_a_transfer_recorded_after_staging(pool: PgPool) {
    let f = seed_org_and_run(&pool).await;
    let le = entity(&pool, f.org).await;
    let (site, moved) = (
        workplace(&pool, f.org, le).await,
        workplace(&pool, f.org, le).await,
    );
    let person = imported(&pool, &f, "emp-1", None).await;
    assign(&pool, f.org, person, Some((le, site)), (LONG_AGO, None)).await;
    materialise(&pool, &f).await;
    transfer(&pool, f.org, person, (le, moved), date!(2026 - 06 - 20)).await;
    lock_period(&pool, f.org, (PERIOD_START, PERIOD_END)).await;
    let closed = close(&pool, &f).await;
    assert_eq!(
        (closed, placements(&pool, f.run).await),
        (Ok(()), vec![placed("emp-1", le, moved, None)])
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_transfer_recorded_after_attendance_close_does_not_move_the_line(pool: PgPool) {
    let f = seed_org_and_run(&pool).await;
    let le = entity(&pool, f.org).await;
    let (site, moved) = (
        workplace(&pool, f.org, le).await,
        workplace(&pool, f.org, le).await,
    );
    let person = imported(&pool, &f, "emp-1", None).await;
    assign(&pool, f.org, person, Some((le, site)), (LONG_AGO, None)).await;
    materialise(&pool, &f).await;
    lock_period(&pool, f.org, (PERIOD_START, PERIOD_END)).await;
    close(&pool, &f).await.unwrap();
    let at_close = placements(&pool, f.run).await;
    transfer(&pool, f.org, person, (le, moved), date!(2026 - 06 - 20)).await;
    materialise(&pool, &f).await;
    let expected = vec![placed("emp-1", le, site, None)];
    assert_eq!(
        (at_close, placements(&pool, f.run).await),
        (expected.clone(), expected)
    );
}

/// An import run keeps its admission rule, imported people only, even when its
/// 법인 has a single pay group whose members include someone with no import.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_import_run_admits_only_imported_people_and_records_their_placement(pool: PgPool) {
    let f = seed_org_and_run(&pool).await;
    let le = entity(&pool, f.org).await;
    let site = workplace(&pool, f.org, le).await;
    pay_group(
        &pool,
        f.org,
        le,
        r#"{"start_day":"FIRST","month_offset":0}"#,
    )
    .await;
    let person = imported(&pool, &f, "emp-1", None).await;
    assign(&pool, f.org, person, Some((le, site)), (LONG_AGO, None)).await;
    let idle = active(&pool, f.org, "emp-2", None).await;
    assign(&pool, f.org, idle, Some((le, site)), (LONG_AGO, None)).await;
    materialise(&pool, &f).await;
    assert_eq!(
        placements(&pool, f.run).await,
        [placed("emp-1", le, site, None)]
    );
}
