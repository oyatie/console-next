// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! A setup batch carries the day it takes effect: a company being set up
//! enters units that have existed for years, and they must read as of then.

mod common;

use common::*;
use console_entity_application::OrgSetupOp;
use sqlx::PgPool;
use time::macros::date;
use uuid::Uuid;

const ORG: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0000_0D47);

/// (effective_from of the latest revision, number of revisions).
async fn record(owner: &PgPool, unit: Uuid) -> (String, i64) {
    sqlx::query_as(
        "SELECT (array_agg(attributes->>'effective_from' ORDER BY version DESC))[1], count(*) \
         FROM org_unit_revisions WHERE org_unit_id = $1",
    )
    .bind(unit)
    .fetch_one(owner)
    .await
    .unwrap()
}

async fn batches(owner: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM org_setup_batches WHERE org_id = $1")
        .bind(ORG)
        .fetch_one(owner)
        .await
        .unwrap()
}

fn rename(unit: Uuid, version: i32, name: &str) -> OrgSetupOp {
    OrgSetupOp::Rename {
        org_unit_id: Some(unit),
        expected_version: Some(version),
        name: Some(name.into()),
    }
}

/// The fixture's 사업장 opened on 2020-03-02; its tree unit starts that day.
const OPENED: time::Date = date!(2020 - 03 - 02);

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_batch_takes_effect_on_its_date_and_today_when_it_names_none(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "A").await;
    let (_, [(hq, hq_site), _]) = two_workplaces(&store, &actor).await;
    assert_eq!(record(&owner, hq_site).await.0, OPENED.to_string());
    let today: String = sqlx::query_scalar("SELECT entity_today()::text")
        .fetch_one(&owner)
        .await
        .unwrap();

    // No date: today, as before.
    let undated = store
        .apply_org_setup_batch(
            &cmd(&actor),
            vec![under_workplace("a", "총무부", hq)],
            port(),
        )
        .await
        .unwrap();
    assert_eq!(record(&owner, undated.units[0].org_unit_id).await.0, today);

    // A company being set up enters a 부서 that began years ago, and the team
    // under it: every unit of the batch is recorded from that day.
    let began = date!(2021 - 03 - 02);
    let dated = store
        .apply_org_setup_batch_on(
            &cmd(&actor),
            vec![
                under_workplace("b", "생산부", hq),
                under_ref("c", "생산1팀", "b"),
            ],
            Some(began),
            port(),
        )
        .await
        .unwrap();
    for unit in &dated.units {
        assert_eq!(
            record(&owner, unit.org_unit_id).await,
            (began.to_string(), 1)
        );
    }

    // A 기준일 on that day shows the 부서 under its 사업장; the day before does not.
    let names_on = |date: time::Date| {
        let (store, actor) = (store.clone(), actor.clone());
        async move {
            let options = console_entity_application::ReadOptions {
                as_of: Some(date),
                known_at: None,
            };
            let tree = store.org_structure_at(&actor, options).await.unwrap();
            let site = &tree.entities[0].children[0];
            site.children
                .iter()
                .map(|c| c.name.clone())
                .collect::<Vec<_>>()
        }
    };
    assert_eq!(names_on(began).await, ["생산부"]);
    assert!(names_on(began.previous_day().unwrap()).await.is_empty());

    // Undo of a dated batch restores the units like any other.
    store
        .undo_org_setup_batch(&cmd(&actor), dated.batch_id, port())
        .await
        .unwrap();
    let (_, status, _, _) = unit_head(&owner, dated.units[0].org_unit_id).await;
    assert_ne!(status, "active");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_date_that_cannot_hold_is_refused_and_nothing_is_written(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "A").await;
    let (_, [(hq, _), _]) = two_workplaces(&store, &actor).await;
    let today: time::Date = sqlx::query_scalar::<_, String>("SELECT entity_today()::text")
        .fetch_one(&owner)
        .await
        .unwrap()
        .parse_date();
    // A 부서 that began in 2022, renamed in 2024.
    let made = store
        .apply_org_setup_batch_on(
            &cmd(&actor),
            vec![under_workplace("a", "총무부", hq)],
            Some(date!(2022 - 01 - 03)),
            port(),
        )
        .await
        .unwrap();
    let unit = made.units[0].org_unit_id;
    store
        .apply_org_setup_batch_on(
            &cmd(&actor),
            vec![rename(unit, 1, "총무팀")],
            Some(date!(2024 - 07 - 01)),
            port(),
        )
        .await
        .unwrap();
    let before = (record(&owner, unit).await, batches(&owner).await);
    assert_eq!(before.0, ("2024-07-01".to_owned(), 2));

    for (ops, on, want) in [
        // Setup applies at once: a change that waits for its day is an org change.
        (
            vec![under_workplace("x", "미래부", hq)],
            today.next_day().unwrap(),
            "org_setup_date_future",
        ),
        // A unit cannot start before the 사업장 it stands in opened.
        (
            vec![under_workplace("x", "과거부", hq)],
            OPENED.previous_day().unwrap(),
            "org_setup_date_before_parent",
        ),
        // Nor a team before the 부서 it is under.
        (
            vec![OrgSetupOp::Create {
                client_ref: None,
                name: Some("총무1팀".into()),
                parent: console_entity_application::OrgParent {
                    parent_org_unit_id: Some(unit),
                    ..console_entity_application::OrgParent::default()
                },
                code: None,
                head_employee_id: None,
            }],
            date!(2021 - 12 - 31),
            "org_setup_date_before_parent",
        ),
        // A change cannot be dated before the unit's current record.
        (
            vec![rename(unit, 2, "경영지원팀")],
            date!(2024 - 06 - 30),
            "org_setup_date_before_current",
        ),
    ] {
        let err = store
            .apply_org_setup_batch_on(&cmd(&actor), ops, Some(on), port())
            .await
            .unwrap_err();
        let (_, fields, _) = code(err);
        assert_eq!(fields, vec![("effective_date".to_owned(), want)], "{on}");
        assert_eq!(
            (record(&owner, unit).await, batches(&owner).await),
            before,
            "{want}: nothing written"
        );
    }
}

trait ParseDate {
    fn parse_date(&self) -> time::Date;
}
impl ParseDate for String {
    fn parse_date(&self) -> time::Date {
        let format = time::macros::format_description!("[year]-[month]-[day]");
        time::Date::parse(self, format).unwrap()
    }
}
