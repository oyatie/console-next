// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Preview names and record names share the existing transaction calendar.
mod common;
use common::*;
use console_entity_application::WorkplaceRevision;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn preview_and_record_names_share_today(owner: PgPool) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "registration-calendar").await;
    let (entity, [(workplace, _), _]) = two_workplaces(&store, &actor).await;
    let registration = store
        .get_entity(&actor, entity, true)
        .await
        .unwrap()
        .registrations[0]
        .id;
    let today: time::Date = sqlx::query_scalar("SELECT (now() AT TIME ZONE 'Asia/Seoul')::date")
        .fetch_one(&owner)
        .await
        .unwrap();
    for (version, date, name) in [
        (1, today, "오늘의 본사"),
        (2, today.next_day().unwrap(), "내일의 본사"),
    ] {
        let mut input = workplace_from(registration, name).input;
        input.status = Some("CONTINUING".into());
        input.name = Some(name.into());
        store
            .revise_workplace(
                &cmd(&actor),
                workplace,
                WorkplaceRevision {
                    expected_version: Some(version),
                    effective_from: Some(date.to_string()),
                    reason_code: Some("CORRECTION".into()),
                    input,
                },
                port(),
            )
            .await
            .unwrap();
    }
    let record = store.get_entity(&actor, entity, true).await.unwrap();
    let current = record
        .workplaces
        .iter()
        .find(|w| w.id == workplace)
        .unwrap()
        .current
        .as_ref()
        .unwrap();
    let preview = store
        .registration_end_options(&actor, registration)
        .await
        .unwrap();
    let linked = preview
        .linked_workplaces
        .iter()
        .find(|w| w.id == workplace)
        .unwrap();
    assert_eq!(current.name, "오늘의 본사");
    assert_eq!(linked.name, current.name);
}
