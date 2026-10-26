// SPDX-License-Identifier: LicenseRef-Proprietary
//! Detail and compact share a population; filters compose with row density.

use console_attendance_adapter_postgres::BoardQuery;
use console_attendance_domain::records::Mark;
use console_attendance_domain::schedule::{DayKind, Level};
use sqlx::PgPool;
use time::macros::date;

use super::save::{cell, save};
use super::support::{assign, key, office, seed, world};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unscheduled_filter_keeps_only_unscheduled_rows_and_clears_hidden_in_a_mixed_group(
    owner: PgPool,
) {
    let w = world(owner).await;
    seed(&w.owner, format!(
        "UPDATE employees SET org_unit_id = '{team}' WHERE id = '{person}'; \
         UPDATE employment_assignments SET workplace_id = '{workplace}' WHERE employee_id = '{person}';",
        team = w.team, person = w.people[2], workplace = w.workplaces[0],
    )).await;
    seed(&w.owner, format!(
        "WITH added AS (INSERT INTO employees (id, org_id, company, name, position, source_filename, source_sheet, source_row, source_key, hire_date, hire_on, employee_number, org_unit_id, employment_status) \
         SELECT gen_random_uuid(), '{org}', 'Co', '일정대상' || n, '사원', 'console', 'console', n, 'detail-' || n, '2020-01-02', '2020-01-02', 'D-' || n, '{team}', 'ACTIVE' FROM generate_series(1, 2) n RETURNING id) \
         INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, workplace_id, valid_from, cause, actor_id, command_id) \
         SELECT '{org}', id, '{entity}', '{workplace}', '2020-01-02', 'HIRE', '{actor}', gen_random_uuid() FROM added;",
        org = w.org, entity = w.entity, team = w.team, workplace = w.workplaces[0], actor = w.admin,
    )).await;
    let (pattern, _) = w
        .store
        .create_pattern(&w.hr(), &key(), office("사무"))
        .await
        .unwrap();
    let day = date!(2026 - 10 - 06);
    for person in &w.people[..2] {
        w.store
            .assign_schedule(
                &w.hr(),
                &key(),
                assign(Level::Person, *person, pattern.id, date!(2026 - 01 - 01)),
            )
            .await
            .unwrap();
    }
    w.store
        .save_entries(
            &w.hr(),
            &key(),
            save(vec![cell(&w, 0, day, "="), cell(&w, 1, day, "=")]),
        )
        .await
        .unwrap();
    let all = w
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
    assert_eq!(all.groups.len(), 1);
    assert_eq!((all.groups[0].rows.len(), all.groups[0].hidden), (3, 2));
    assert!(
        all.groups[0]
            .rows
            .iter()
            .any(|r| r.day.marks.contains(&Mark::NoSchedule))
    );
    let detailed = w
        .store
        .day_board(
            &w.hr(),
            BoardQuery {
                date: Some(day),
                all_rows: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(detailed.ledger.people, 5);
    assert_eq!(
        (detailed.groups[0].rows.len(), detailed.groups[0].hidden),
        (5, 0)
    );
    for all_rows in [false, true] {
        let issues = w
            .store
            .day_board(
                &w.hr(),
                BoardQuery {
                    date: Some(day),
                    issues_only: true,
                    all_rows,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(issues.ledger.people, 5);
        assert_eq!(issues.groups.len(), 1);
        assert_eq!(issues.groups[0].rows.len(), 3);
        assert!(
            issues.groups[0]
                .rows
                .iter()
                .all(|r| !r.day.marks.is_empty())
        );
    }
    let filtered = w
        .store
        .day_board(
            &w.hr(),
            BoardQuery {
                date: Some(day),
                no_schedule_only: true,
                all_rows: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        (
            filtered.ledger.people,
            filtered.ledger.normal,
            filtered.ledger.no_record,
            filtered.ledger.no_schedule
        ),
        (5, 2, 0, 3)
    );
    assert_eq!(filtered.groups.len(), 1);
    let group = &filtered.groups[0];
    assert_eq!(
        (group.people, group.normal, group.no_schedule, group.hidden),
        (5, 2, 3, 0)
    );
    assert_eq!(group.rows.len(), 3);
    assert!(group.rows.iter().any(|r| r.employee_id == w.people[2]));
    assert!(
        group
            .rows
            .iter()
            .all(|r| r.day.plan.kind == DayKind::NoSchedule)
    );
}
