// SPDX-License-Identifier: LicenseRef-Proprietary
//! Unscheduled people remain actionable, and shortfalls stop at the KST day boundary.

use console_attendance_adapter_postgres::{BoardQuery, GridQuery};
use console_attendance_domain::records::Mark;
use console_attendance_domain::schedule::DayKind;
use sqlx::PgPool;
use time::{Duration, macros::date};

use super::save::{cell, save, scheduled};
use super::support::{key, seed, today};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unscheduled_people_are_visible_and_never_normal_at_two_thousand(owner: PgPool) {
    let w = scheduled(owner).await;
    seed(&w.owner, format!(
        "WITH added AS (INSERT INTO employees (id, org_id, company, name, position, source_filename, source_sheet, source_row, source_key, hire_date, hire_on, employee_number, employment_status) \
         SELECT gen_random_uuid(), '{org}', 'Co', '일정대상' || n, '사원', 'console', 'console', n, 'scale-' || n, '2020-01-02', '2020-01-02', 'U-' || n, 'ACTIVE' FROM generate_series(1, 1997) n RETURNING id) \
         INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, workplace_id, valid_from, cause, actor_id, command_id) \
         SELECT '{org}', id, '{entity}', '{workplace}', '2020-01-02', 'HIRE', '{actor}', gen_random_uuid() FROM added;",
        org = w.org, entity = w.entity, workplace = w.workplaces[1], actor = w.admin,
    )).await;
    let board = w
        .store
        .day_board(
            &w.hr(),
            BoardQuery {
                date: Some(date!(2026 - 10 - 06)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        (
            board.ledger.people,
            board.ledger.no_schedule,
            board.ledger.normal
        ),
        (2000, 1998, 0)
    );
    let group = board
        .groups
        .iter()
        .find(|g| g.workplace_id == Some(w.workplaces[1]))
        .unwrap();
    assert_eq!(
        group.normal, 0,
        "no resolved schedule must never be counted 정상"
    );
    assert_eq!(serde_json::to_value(group).unwrap()["no_schedule"], 1998);
    assert_eq!((group.rows.len(), group.hidden), (1998, 0));
    assert!(
        group
            .rows
            .iter()
            .all(|r| r.day.marks.contains(&Mark::NoSchedule))
    );
    let filtered = w
        .store
        .day_board(
            &w.hr(),
            BoardQuery {
                date: Some(date!(2026 - 10 - 06)),
                no_schedule_only: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        (filtered.ledger.people, filtered.ledger.no_schedule),
        (2000, 1998)
    );
    assert_eq!(filtered.groups.len(), 1);
    assert_eq!(filtered.groups[0].rows.len(), 1998);
    assert!(
        filtered.groups[0]
            .rows
            .iter()
            .all(|r| r.day.plan.kind == DayKind::NoSchedule)
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unscheduled_recorded_time_stays_in_the_unscheduled_bucket(owner: PgPool) {
    let w = scheduled(owner).await;
    let day = date!(2026 - 10 - 06);
    w.store
        .save_entries(&w.hr(), &key(), save(vec![cell(&w, 2, day, "9-18")]))
        .await
        .unwrap();
    let board = w
        .store
        .day_board(
            &w.hr(),
            BoardQuery {
                date: Some(day),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        board.ledger.no_schedule, 1,
        "recording evidence does not resolve a schedule"
    );
    let row = &board
        .groups
        .iter()
        .find(|g| g.workplace_id == Some(w.workplaces[1]))
        .unwrap()
        .rows[0];
    assert_eq!(
        (row.day.recognition.recorded, row.day.recognition.recognised),
        (540, 540)
    );
    assert_eq!(row.day.marks, vec![Mark::NoSchedule]);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn month_shortfalls_exclude_today_future_days_and_registered_holidays(owner: PgPool) {
    let w = scheduled(owner).await;
    let today = today();
    let month = format!("{}-{:02}", today.year(), u8::from(today.month()));
    let person = w
        .store
        .person_month(&w.hr(), w.people[0], month.clone())
        .await
        .unwrap();
    let expected: u32 = person
        .days
        .iter()
        .filter(|d| d.date < today && d.plan.kind == DayKind::Work)
        .map(|d| {
            let shift = d.plan.shift.as_ref().unwrap();
            u32::from(shift.end - shift.start)
                - shift
                    .breaks
                    .iter()
                    .map(|b| u32::from(b.end - b.start))
                    .sum::<u32>()
        })
        .sum();
    assert_eq!(person.totals.not_worked, expected);
    assert!(person.days.iter().filter(|d| d.date >= today).all(|d| {
        let r = d.recognition;
        r.late_in + r.early_out + r.away == 0
    }));
    let grid = w
        .store
        .month_grid(
            &w.hr(),
            GridQuery {
                month,
                limit: 100,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let row = grid
        .rows
        .iter()
        .find(|r| r.employee_id == w.people[0])
        .unwrap();
    assert_eq!(row.totals.not_worked, expected);
    assert!(
        row.cells
            .iter()
            .filter(|d| d.date >= today)
            .all(|d| d.not_worked == 0)
    );
    // The public holiday register, rather than a weekday shortcut, decides the shortfall.
    let october = w
        .store
        .person_month(&w.hr(), w.people[0], "2026-10".into())
        .await
        .unwrap();
    let holiday = october
        .days
        .iter()
        .find(|d| d.date == date!(2026 - 10 - 09))
        .unwrap();
    assert_eq!(holiday.plan.kind, DayKind::PublicHoliday);
    assert_eq!(holiday.recognition.away, 0);
    let future = today + Duration::days(40);
    let future_month = format!("{}-{:02}", future.year(), u8::from(future.month()));
    assert_eq!(
        w.store
            .person_month(&w.hr(), w.people[0], future_month)
            .await
            .unwrap()
            .totals
            .not_worked,
        0
    );
}
