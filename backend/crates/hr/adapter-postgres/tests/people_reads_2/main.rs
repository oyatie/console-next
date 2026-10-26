#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! PEOPLE-READS-2 against Postgres as `console_rt`: roster keyset paging (A1),
//! the lifecycle history cursor (A8), bulk per-line units (A5) and selection by
//! query with exclusions (A4), and the 근로자 명부 export layout (SC-HRR-003).

mod department;
mod fixtures;
mod membership;
mod register;
#[path = "../support/mod.rs"]
mod support;

use console_hr_adapter_postgres::lifecycle::events_page::LifecycleEventsQuery;
use serde_json::{Value, json};
use sqlx::PgPool;
use support::{employee, principal, query, tenant, user};
use uuid::Uuid;

use fixtures::{bulk_body, fixture, site};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn roster_keyset_pages_never_repeat_or_skip_and_refuse_foreign_cursors(pool: PgPool) {
    let t = tenant(&pool).await;
    for (name, number) in [
        ("Choi", "E-3"),
        ("Kim", "E-1"),
        ("Lee", "E-5"),
        ("Park", "E-2"),
        ("Yoon", "E-4"),
    ] {
        employee(&pool, t.org, name, number, "ACTIVE").await;
    }
    let hr_user = user(&pool, t.org, None).await;
    let reader = || principal(t.org, hr_user);

    let first =
        t.hr.list_employees(reader(), query(json!({ "sort": "name", "limit": 2 })))
            .await
            .unwrap();
    assert_eq!(first.total, 5);
    let names = |page: &console_hr_adapter_postgres::directory::types::EmployeePage| {
        page.items
            .iter()
            .map(|e| e.name.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(names(&first), ["Choi", "Kim"]);
    // A row sorting before the cursor, added mid-paging, never shifts the next page.
    employee(&pool, t.org, "Ahn", "E-9", "ACTIVE").await;
    let cursor = first.next_cursor.clone().unwrap();
    let second =
        t.hr.list_employees(reader(), query(json!({ "cursor": cursor, "limit": 2 })))
            .await
            .unwrap();
    assert_eq!(names(&second), ["Lee", "Park"]);
    let third =
        t.hr.list_employees(
            reader(),
            query(json!({ "cursor": second.next_cursor.clone().unwrap(), "limit": 2 })),
        )
        .await
        .unwrap();
    assert_eq!(
        (names(&third), third.next_cursor.clone()),
        (vec!["Yoon".to_owned()], None)
    );

    let by_number =
        t.hr.list_employees(reader(), query(json!({ "sort": "-employee_number" })))
            .await
            .unwrap();
    let numbers: Vec<_> = by_number
        .items
        .iter()
        .map(|e| e.employee_number.clone().unwrap())
        .collect();
    assert_eq!(numbers, ["E-9", "E-5", "E-4", "E-3", "E-2", "E-1"]);

    for bad in [
        json!({ "sort": "-name", "cursor": cursor }),
        json!({ "cursor": cursor, "offset": 2 }),
        json!({ "cursor": "zz" }),
        json!({ "sort": "salary" }),
    ] {
        let err =
            t.hr.list_employees(reader(), query(bad.clone()))
                .await
                .unwrap_err();
        assert_eq!(err.status.as_u16(), 422, "{bad}");
    }
    // Without sort or cursor the offset read is unchanged.
    let legacy =
        t.hr.list_employees(reader(), query(json!({ "offset": 5 })))
            .await
            .unwrap();
    assert_eq!((legacy.items.len(), legacy.next_cursor), (1, None));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn lifecycle_history_pages_by_cursor_newest_first(pool: PgPool) {
    let t = tenant(&pool).await;
    let person = employee(&pool, t.org, "Kim", "E-1", "ACTIVE").await;
    let hr_user = user(&pool, t.org, None).await;
    for day in 1..=5 {
        fixture(
            &pool,
            &format!(
                "INSERT INTO employee_lifecycle_events (org_id, employee_id, event_type, to_status, \
                 effective_date, comment, created_by, created_at) VALUES ($1, $2, 'PROMOTE', 'ACTIVE', \
                 '2026-09-0{day}', 'p{day}', $3, TIMESTAMPTZ '2026-09-0{day} 09:00+09')"
            ),
            t.org,
            &[person, *hr_user.as_uuid()],
        )
        .await;
    }
    let mut seen = Vec::new();
    let mut cursor = None;
    loop {
        let page =
            t.hr.lifecycle_events(
                principal(t.org, hr_user),
                person,
                LifecycleEventsQuery {
                    limit: Some(2),
                    cursor,
                },
                false,
            )
            .await
            .unwrap();
        seen.extend(page.items.iter().map(|e| e.comment.clone()));
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    assert_eq!(seen, ["p5", "p4", "p3", "p2", "p1"]);
    let all =
        t.hr.lifecycle_events(
            principal(t.org, hr_user),
            person,
            LifecycleEventsQuery::default(),
            false,
        )
        .await
        .unwrap();
    assert_eq!((all.items.len(), all.next_cursor), (5, None));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn bulk_transfer_takes_a_unit_per_line_in_one_batch(pool: PgPool) {
    let t = tenant(&pool).await;
    let hr_user = user(&pool, t.org, None).await;
    let (north, south) = (
        site(&pool, t.org, *hr_user.as_uuid(), "North").await,
        site(&pool, t.org, *hr_user.as_uuid(), "South").await,
    );
    let a = employee(&pool, t.org, "Kim", "E-1", "ACTIVE").await;
    let b = employee(&pool, t.org, "Lee", "E-2", "ACTIVE").await;
    let lines = json!({ "lines": [
        { "employee_id": a, "to_org_unit_id": north },
        { "employee_id": b, "to_org_unit_id": south },
    ] });
    let done =
        t.hr.bulk_lifecycle_events(
            principal(t.org, hr_user),
            "bulk-lines-key-00001".into(),
            bulk_body(lines),
        )
        .await
        .unwrap();
    let units: Vec<_> = done["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["to_org_unit"].clone())
        .collect();
    assert_eq!(units, [json!("North"), json!("South")]);
    assert!(
        done["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["batch_id"] == done["batch_id"])
    );

    for bad in [
        json!({ "lines": [{ "employee_id": a, "to_org_unit_id": north }], "to_org_unit_id": south }),
        json!({ "lines": [{ "employee_id": a, "to_org_unit_id": north }], "employee_ids": [b] }),
        json!({ "event_type": "PROMOTE", "to_position": "Lead", "lines": [{ "employee_id": a, "to_org_unit_id": north }] }),
        json!({ "lines": [{ "employee_id": a, "to_org_unit_id": north }, { "employee_id": a, "to_org_unit_id": south }] }),
    ] {
        let err =
            t.hr.bulk_lifecycle_events(
                principal(t.org, hr_user),
                "bulk-lines-bad-00001".into(),
                bulk_body(bad.clone()),
            )
            .await
            .unwrap_err();
        assert_eq!(err.status.as_u16(), 422, "{bad}: {}", err.message);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn bulk_selection_by_query_minus_exclusions_checks_the_confirmed_count(pool: PgPool) {
    let t = tenant(&pool).await;
    let hr_user = user(&pool, t.org, None).await;
    let team = site(&pool, t.org, *hr_user.as_uuid(), "Team").await;
    let mut active = Vec::new();
    for n in 0..4 {
        active.push(employee(&pool, t.org, &format!("A{n}"), &format!("A-{n}"), "ACTIVE").await);
    }
    employee(&pool, t.org, "Away", "L-1", "ON_LEAVE").await;
    let selection = |expected: usize| {
        bulk_body(json!({ "to_org_unit_id": team, "selection": {
            "query": { "status": "ACTIVE" },
            "exclude_employee_ids": [active[0]],
            "expected_count": expected,
        } }))
    };
    let recorded = || async {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM employee_lifecycle_events WHERE org_id = $1",
        )
        .bind(t.org)
        .fetch_one(&pool)
        .await
        .unwrap()
    };

    let err =
        t.hr.bulk_lifecycle_events(
            principal(t.org, hr_user),
            "bulk-select-stale-01".into(),
            selection(4),
        )
        .await
        .unwrap_err();
    assert_eq!(
        (err.status.as_u16(), err.code),
        (409, "bulk_selection_changed"),
        "{}",
        err.message
    );
    assert_eq!(recorded().await, 0);

    let done =
        t.hr.bulk_lifecycle_events(
            principal(t.org, hr_user),
            "bulk-select-ok-0001".into(),
            selection(3),
        )
        .await
        .unwrap();
    let moved: Vec<Uuid> = done["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| serde_json::from_value(i["employee_id"].clone()).unwrap())
        .collect();
    assert_eq!(moved.len(), 3);
    assert!(!moved.contains(&active[0]));
    let audit: Value = sqlx::query_scalar(
        "SELECT after_snap FROM audit_events WHERE org_id = $1 AND action = 'employee.lifecycle.bulk'",
    )
    .bind(t.org)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audit["count"], 3);
    assert_eq!(audit["selection"]["expected_count"], 3);

    let both = bulk_body(json!({ "to_org_unit_id": team, "employee_ids": [active[1]],
        "selection": { "query": {}, "expected_count": 1 } }));
    let err =
        t.hr.bulk_lifecycle_events(
            principal(t.org, hr_user),
            "bulk-select-both-01".into(),
            both,
        )
        .await
        .unwrap_err();
    assert_eq!(err.status.as_u16(), 422);
}
