// SPDX-License-Identifier: LicenseRef-Proprietary
//! A regular run of a legal entity's only pay group lists every member of that
//! legal entity once, imported or not, each placed as of the run's base-period end.
use super::places::*;
use super::seed::*;
use sqlx::PgPool;
use time::macros::date;
use time::{Date, Duration};
use uuid::Uuid;

pub(crate) const MONTHLY: &str = r#"{"start_day":"FIRST","month_offset":0}"#;
pub(crate) const JUNE: (Date, Date) = (PERIOD_START, PERIOD_END);

/// A legal entity with one workplace and a single monthly pay group, and its June
/// run.
pub(crate) async fn single_group_run(pool: &PgPool, kind: &str) -> (Fixture, Uuid, Uuid) {
    let org = seed_org_and_run(pool).await.org;
    let le = entity(pool, org).await;
    let site = workplace(pool, org, le).await;
    let group = pay_group(pool, org, le, MONTHLY).await;
    (group_run(pool, org, group, kind, JUNE).await, le, site)
}

pub(crate) async fn member(pool: &PgPool, f: &Fixture, key: &str, place: (Uuid, Uuid)) -> Uuid {
    let id = active(pool, f.org, key, None).await;
    assign(pool, f.org, id, Some(place), (LONG_AGO, None)).await;
    id
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_regular_run_lists_each_member_of_its_legal_entity_once_with_their_placement(
    pool: PgPool,
) {
    let (f, le, w1) = single_group_run(&pool, "REGULAR").await;
    let (org, team) = (f.org, unit(&pool, f.org).await);
    let w2 = workplace(&pool, org, le).await;
    let other = entity(&pool, org).await;
    let far = workplace(&pool, org, other).await;
    let mut people = Vec::new();
    for (key, status, span, places) in [
        ("full", "ACTIVE", (None, None), vec![(w1, LONG_AGO, None)]),
        (
            "hired-15th",
            "ACTIVE",
            (Some(date!(2026 - 06 - 15)), None),
            vec![(w1, date!(2026 - 06 - 15), None)],
        ),
        (
            "exited-10th",
            "EXITED",
            (None, Some(date!(2026 - 06 - 10))),
            vec![(w1, LONG_AGO, Some(date!(2026 - 06 - 11)))],
        ),
        (
            "moved",
            "ACTIVE",
            (None, None),
            vec![
                (w1, LONG_AGO, Some(date!(2026 - 06 - 15))),
                (w2, date!(2026 - 06 - 15), None),
            ],
        ),
        (
            "pre-hire",
            "PRE_HIRE",
            (Some(date!(2026 - 06 - 20)), None),
            vec![(w1, date!(2026 - 06 - 20), None)],
        ),
        // Assigned throughout: only the recorded hire or exit date keeps these two off.
        (
            "hired-after",
            "PRE_HIRE",
            (Some(date!(2026 - 07 - 05)), None),
            vec![(w1, LONG_AGO, None)],
        ),
        (
            "exited-before",
            "EXITED",
            (None, Some(date!(2026 - 05 - 20))),
            vec![(w1, LONG_AGO, None)],
        ),
        ("merged", "ACTIVE", (None, None), vec![(w1, LONG_AGO, None)]),
        ("voided", "ACTIVE", (None, None), vec![(w1, LONG_AGO, None)]),
        // Left on a day nobody recorded, with the assignment never closed.
        (
            "exited-undated",
            "EXITED",
            (None, None),
            vec![(w1, LONG_AGO, None)],
        ),
    ] {
        let id = person(&pool, org, key, Some(team), status, span).await;
        for (site, from, to) in places {
            assign(&pool, org, id, Some((le, site)), (from, to)).await;
        }
        people.push(id);
    }
    let elsewhere = active(&pool, org, "other-entity", Some(team)).await;
    assign(&pool, org, elsewhere, Some((other, far)), (LONG_AGO, None)).await;
    active(&pool, org, "unassigned", Some(team)).await;
    let unmapped = active(&pool, org, "unmapped", Some(team)).await;
    assign(&pool, org, unmapped, None, (LONG_AGO, None)).await;
    let (full, merged, voided) = (people[0], people[7], people[8]);
    sqlx::query("UPDATE employees SET merged_into_employee_id=$2 WHERE id=$1")
        .bind(merged)
        .bind(full)
        .execute(&pool)
        .await
        .unwrap();
    let voider = user(&pool, org).await;
    sqlx::query("UPDATE employees SET employment_status='VOIDED',voided_at=now(),voided_by=$2,void_reason_code='MISTAKE',void_mode='SETUP' WHERE id=$1")
        .bind(voided).bind(voider).execute(&pool).await.unwrap();
    let written = materialise_for(&pool, &f, JUNE).await;
    assert_eq!(
        (written, placements(&pool, f.run).await),
        (
            5,
            vec![
                placed("exited-10th", le, w1, Some(team)),
                placed("full", le, w1, Some(team)),
                placed("hired-15th", le, w1, Some(team)),
                placed("moved", le, w2, Some(team)),
                placed("pre-hire", le, w1, Some(team)),
            ]
        )
    );
}

/// Someone hired later in the period has not started when the run is created, so
/// their line waits for the close; until then a no-show can still be voided.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_member_who_has_not_started_is_not_on_the_roster_yet(pool: PgPool) {
    let org = seed_org_and_run(&pool).await.org;
    let le = entity(&pool, org).await;
    let site = workplace(&pool, org, le).await;
    let group = pay_group(&pool, org, le, MONTHLY).await;
    let today: Date = sqlx::query_scalar("SELECT entity_today()")
        .fetch_one(&pool)
        .await
        .unwrap();
    let period = (today - Duration::days(10), today + Duration::days(20));
    let f = group_run(&pool, org, group, "REGULAR", period).await;
    let started = active(&pool, org, "started", None).await;
    assign(&pool, org, started, Some((le, site)), (LONG_AGO, None)).await;
    let starts = today + Duration::days(5);
    let span = (Some(starts), None);
    let pending = person(&pool, org, "starts-later", None, "PRE_HIRE", span).await;
    assign(&pool, org, pending, Some((le, site)), (starts, None)).await;
    materialise_for(&pool, &f, period).await;
    assert_eq!(
        placements(&pool, f.run).await,
        [placed("started", le, site, None)]
    );
}

/// A group whose base period runs from the 16th of the previous month is placed
/// at that period's end, not the attribution month's: a move on the 20th is
/// after the work the run pays.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_offset_group_places_lines_at_its_base_period_end(pool: PgPool) {
    let org = seed_org_and_run(&pool).await.org;
    let le = entity(&pool, org).await;
    let (site, later) = (
        workplace(&pool, org, le).await,
        workplace(&pool, org, le).await,
    );
    let (team, next_team) = (unit(&pool, org).await, unit(&pool, org).await);
    let group = pay_group(&pool, org, le, r#"{"start_day":16,"month_offset":-1}"#).await;
    let period = (date!(2026 - 05 - 16), date!(2026 - 06 - 15));
    let f = group_run(&pool, org, group, "REGULAR", period).await;
    let person = active(&pool, org, "emp-1", Some(next_team)).await;
    assign(&pool, org, person, Some((le, site)), (LONG_AGO, None)).await;
    transfer(&pool, org, person, (le, later), date!(2026 - 06 - 20)).await;
    department_move(&pool, org, person, (team, next_team), date!(2026 - 06 - 20)).await;
    materialise_for(&pool, &f, period).await;
    assert_eq!(
        placements(&pool, f.run).await,
        [placed("emp-1", le, site, Some(team))]
    );
}

/// Someone who moves to another legal entity mid-period is still a member of this
/// run and is placed in this run's legal entity, at the workplace they left from.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_member_moved_to_another_legal_entity_is_placed_in_the_runs_legal_entity(pool: PgPool) {
    let (f, le, site) = single_group_run(&pool, "REGULAR").await;
    let other = entity(&pool, f.org).await;
    let far = workplace(&pool, f.org, other).await;
    let person = member(&pool, &f, "emp-1", (le, site)).await;
    transfer(&pool, f.org, person, (other, far), date!(2026 - 06 - 15)).await;
    materialise_for(&pool, &f, JUNE).await;
    assert_eq!(
        placements(&pool, f.run).await,
        [placed("emp-1", le, site, None)]
    );
}

/// Attendance imported for exactly the base period reaches a member's line; a
/// member without it still gets a line; an import for a non-member adds no one.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn imported_attendance_for_the_base_period_reaches_member_lines(pool: PgPool) {
    let (f, le, site) = single_group_run(&pool, "REGULAR").await;
    member(&pool, &f, "emp-1", (le, site)).await;
    member(&pool, &f, "emp-2", (le, site)).await;
    let other = entity(&pool, f.org).await;
    let far = workplace(&pool, f.org, other).await;
    member(&pool, &f, "outsider", (other, far)).await;
    for key in ["emp-1", "outsider"] {
        seed_import(
            &pool,
            f.org,
            "APPLIED",
            "CANDIDATE",
            JUNE,
            key,
            attendance_row(),
        )
        .await;
    }
    materialise_for(&pool, &f, JUNE).await;
    assert_eq!(
        roster(&pool, &f).await,
        [("emp-1".to_owned(), 0, 1), ("emp-2".to_owned(), 0, 0)]
    );
}
