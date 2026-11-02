// SPDX-License-Identifier: LicenseRef-Proprietary
//! Issue aggregates describe the whole scope, independent of filters and keysets.
use console_attendance_adapter_postgres::BoardQuery;
use console_attendance_domain::records::Mark;
use sqlx::PgPool;
use time::macros::date;
use uuid::Uuid;

use super::save::{cell, save, scheduled};
use super::support::{assign, key, office, seed, world};
use console_attendance_domain::schedule::Level;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn issue_groups_preserve_scope_counts_before_filtering(owner: PgPool) {
    let w = scheduled(owner).await;
    let day = date!(2026 - 10 - 06);
    w.store
        .save_entries(&w.hr(), &key(), save(vec![cell(&w, 0, day, "9-")]))
        .await
        .unwrap();
    for mark in [None, Some(Mark::MissingOut), Some(Mark::Late)] {
        let board = w
            .store
            .day_board(
                &w.hr(),
                BoardQuery {
                    date: Some(day),
                    mark,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(board.ledger.people, 3);
        let groups = board
            .issue_groups
            .iter()
            .map(|g| (g.kind, g.count, g.earliest_date))
            .collect::<Vec<_>>();
        assert_eq!(
            groups,
            vec![
                (Mark::NoRecord, 1, date!(2026 - 10 - 01)),
                (Mark::MissingOut, 1, day),
                (Mark::NoSchedule, 1, date!(2026 - 10 - 01))
            ]
        );
        let rows: Vec<_> = board.groups.iter().flat_map(|g| &g.rows).collect();
        match mark {
            None => assert_eq!(rows.len(), 3),
            Some(Mark::MissingOut) => assert_eq!(rows[0].employee_id, w.people[0]),
            _ => assert!(rows.is_empty()),
        }
    }
    let scoped = w
        .store
        .day_board(
            &w.seoul_hr(),
            BoardQuery {
                date: Some(day),
                mark: Some(Mark::MissingOut),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(scoped.ledger.people, 1);
    assert!(scoped.groups.is_empty());
    assert_eq!(
        (scoped.issue_groups[0].kind, scoped.issue_groups[0].count),
        (Mark::NoSchedule, 1)
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn earliest_issue_uses_the_month_and_historical_roster_in_authorized_scope(owner: PgPool) {
    let w = scheduled(owner).await;
    let (pattern, _) = w
        .store
        .create_pattern(&w.hr(), &key(), office("서울 사무"))
        .await
        .unwrap();
    w.store
        .assign_schedule(
            &w.hr(),
            &key(),
            assign(
                Level::Workplace,
                w.workplaces[1],
                pattern.id,
                date!(2026 - 01 - 01),
            ),
        )
        .await
        .unwrap();
    w.store
        .save_entries(
            &w.hr(),
            &key(),
            save(vec![
                cell(&w, 0, date!(2026 - 09 - 30), "9-"),
                cell(&w, 0, date!(2026 - 10 - 02), "9-"),
                cell(&w, 1, date!(2026 - 10 - 06), "9-"),
                cell(&w, 2, date!(2026 - 10 - 01), "9-"),
                cell(&w, 2, date!(2026 - 10 - 06), "9-"),
            ]),
        )
        .await
        .unwrap();
    seed(
        &w.owner,
        format!(
            "UPDATE employees SET exit_on='2026-10-03' WHERE id='{}'",
            w.people[0]
        ),
    )
    .await;
    for (caller, workplace, expected) in [
        (w.hr(), Some(w.workplaces[0]), Some(date!(2026 - 10 - 02))),
        (w.seoul_hr(), None, Some(date!(2026 - 10 - 01))),
    ] {
        let board = w
            .store
            .day_board(
                &caller,
                BoardQuery {
                    date: Some(date!(2026 - 10 - 06)),
                    workplace_id: workplace,
                    mark: Some(Mark::MissingOut),
                    limit: Some(1),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let group = board
            .issue_groups
            .iter()
            .find(|g| g.kind == Mark::MissingOut);
        assert_eq!(group.map(|g| g.earliest_date), expected);
        if let Some(group) = group {
            assert_eq!(group.count, 1, "counts still describe the requested day");
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn two_thousand_people_have_stable_uuid_pages_and_unpaged_counts(owner: PgPool) {
    let w = world(owner).await;
    seed(&w.owner, format!(
        "WITH added AS (INSERT INTO employees (id, org_id, company, name, position, source_filename, source_sheet, source_row, source_key, hire_date, hire_on, employee_number, employment_status) \
         SELECT gen_random_uuid(), '{org}', 'Co', '대상' || n, '사원', 'console', 'console', n, 'issues-' || n, '2020-01-02', '2020-01-02', 'I-' || n, 'ACTIVE' FROM generate_series(1, 1997) n RETURNING id) \
         INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, workplace_id, valid_from, cause, actor_id, command_id) \
         SELECT '{org}', id, '{entity}', '{workplace}', '2020-01-02', 'HIRE', '{actor}', gen_random_uuid() FROM added;",
        org = w.org, entity = w.entity, workplace = w.workplaces[0], actor = w.admin,
    )).await;
    for (limit, expected) in [(0, 1), (usize::MAX, 200)] {
        let board = w
            .store
            .day_board(
                &w.hr(),
                BoardQuery {
                    date: Some(date!(2026 - 10 - 06)),
                    limit: Some(limit),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(
            board.groups.iter().map(|g| g.rows.len()).sum::<usize>(),
            expected
        );
        assert!(board.next_cursor.is_some());
    }
    let mut cursor = None;
    let mut seen = std::collections::BTreeSet::new();
    loop {
        let board = w
            .store
            .day_board(
                &w.hr(),
                BoardQuery {
                    date: Some(date!(2026 - 10 - 06)),
                    mark: Some(Mark::NoSchedule),
                    cursor,
                    limit: Some(200),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(board.ledger.people, 2000);
        assert_eq!(board.issue_groups.len(), 1);
        assert_eq!(board.issue_groups[0].count, 2000);
        let ids: Vec<_> = board
            .groups
            .iter()
            .flat_map(|g| &g.rows)
            .map(|r| r.employee_id)
            .collect();
        assert_eq!(ids.len(), 200);
        for id in ids {
            assert!(cursor.is_none_or(|cursor| id > cursor));
            assert!(seen.insert(id));
        }
        cursor = board.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(seen.len(), 2000);
    // An arbitrary or no-longer-visible cursor must never restart at page one.
    let last = w
        .store
        .day_board(
            &w.hr(),
            BoardQuery {
                date: Some(date!(2026 - 10 - 06)),
                cursor: Some(Uuid::max()),
                limit: Some(200),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(last.groups.is_empty());
    assert!(last.next_cursor.is_none());
    assert_eq!(last.issue_groups[0].count, 2000);
}
