#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Ribbons and comparison changes follow visibility at each event, including transient units.
mod common;
use common::*;
use console_entity_application::{Actor, EntityScope, ReadOptions, nodes};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Date, Duration, OffsetDateTime};
use uuid::Uuid;

async fn request(
    owner: &PgPool,
    actor: &Actor,
    unit: Uuid,
    date: Date,
    code: &str,
    proposal: Value,
    status: &str,
) {
    let id = Uuid::new_v4();
    // Use the temporal adapter request-fixture seam; projection history is trigger-owned.
    sqlx::query("INSERT INTO org_change_requests (id,org_id,code,kind,status,target_kind,target_ref,target_label, \
        effective_date,reason,proposal,drafted_by,idempotency_key,request_fingerprint) \
        VALUES ($1,$2,$3,'REORG',$8,'ORG_UNIT',$4,'A',$5,'Scoped timeline fixture',$6,$7,$1::text,repeat('0',64))")
        .bind(id).bind(*actor.org.as_uuid()).bind(code).bind(unit.to_string()).bind(date)
        .bind(proposal).bind(*actor.user.as_uuid()).bind(status).execute(owner).await.unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn approved_move_departure_is_visible_but_later_hidden_rename_is_not_a_scoped_change_date(
    owner: PgPool,
) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "asof-projected-ribbon-scope").await;
    let today: Date = sqlx::query_scalar("SELECT (now() AT TIME ZONE 'Asia/Seoul')::date")
        .fetch_one(&owner)
        .await
        .unwrap();
    let (entity, [(hq, _hq_site), (plant, plant_site)]) = two_workplaces(&store, &actor).await;
    let setup = store
        .apply_org_setup_batch(
            &cmd(&actor),
            vec![
                under_workplace("a", "A", hq),
                under_ref("child", "Child", "a"),
            ],
            port(),
        )
        .await
        .unwrap();
    let unit = setup.units[0].org_unit_id;
    for (index, unit) in setup.units.iter().enumerate() {
        person(
            &owner,
            &store,
            &actor,
            (entity, hq, unit.org_unit_id),
            &format!("mover-{index}"),
        )
        .await;
    }
    let native_tree = store.org_structure(&actor).await.unwrap();
    assert_eq!(nodes(&native_tree)[&hq].0.headcount, 2);
    assert_eq!(nodes(&native_tree)[&plant].0.headcount, 0);
    let scoped = Actor {
        scope: EntityScope::Only(vec![hq]),
        ..actor.clone()
    };
    let cutoff: OffsetDateTime = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&owner)
        .await
        .unwrap();
    let departure = today + Duration::days(5);
    let hidden_rename = today + Duration::days(20);
    request(
        &owner,
        &actor,
        unit,
        departure,
        "OC-2026-0001",
        json!([{"op":"MOVE_ORG_UNIT","orgUnitId":unit,"parentId":plant_site}]),
        "APPROVED",
    )
    .await;
    request(
        &owner,
        &actor,
        unit,
        hidden_rename,
        "OC-2026-0002",
        json!([{"op":"RENAME_ORG_UNIT","orgUnitId":unit,"name":"Hidden rename"}]),
        "APPROVED",
    )
    .await;

    let projected = store
        .org_structure_at(
            &scoped,
            ReadOptions {
                as_of: Some(hidden_rename),
                known_at: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(projected.entities[0].children.len(), 1);
    assert_eq!(projected.entities[0].children[0].id, hq);
    assert!(!nodes(&projected).contains_key(&unit));
    assert_eq!(nodes(&projected)[&hq].0.headcount, 0);
    assert!(!nodes(&projected).contains_key(&setup.units[1].org_unit_id));
    let range_end = hidden_rename + Duration::days(5);
    let ribbon = store
        .structure_change_dates(&scoped, today, range_end, ReadOptions::default())
        .await
        .unwrap();
    assert!(
        ribbon.contains(&departure.to_string()),
        "moving out changes the visible HQ tree on D1"
    );
    assert!(
        !ribbon.contains(&hidden_rename.to_string()),
        "a rename after leaving HQ must not expose hidden D2"
    );

    let all_dates = store
        .structure_change_dates(&actor, today, range_end, ReadOptions::default())
        .await
        .unwrap();
    assert!(all_dates.contains(&departure.to_string()));
    assert!(
        all_dates.contains(&hidden_rename.to_string()),
        "tenant-wide scope retains the later Plant change"
    );
    let all = store
        .org_structure_at(
            &actor,
            ReadOptions {
                as_of: Some(hidden_rename),
                known_at: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(nodes(&all).get(&unit).unwrap().0.name, "Hidden rename");
    let all_nodes = nodes(&all);
    assert_eq!(all_nodes[&hq].0.headcount, 0);
    assert_eq!(
        all_nodes[&plant].0.headcount, 2,
        "both direct and nested members follow the moved branch"
    );
    assert_eq!(all_nodes[&setup.units[1].org_unit_id].0.direct_headcount, 1);

    // Before either approval was known, the same future date still reads the native HQ membership.
    let historical = ReadOptions {
        as_of: Some(hidden_rename),
        known_at: Some(cutoff),
    };
    let prior = store.org_structure_at(&scoped, historical).await.unwrap();
    let prior_nodes = nodes(&prior);
    let native = prior_nodes.get(&unit).unwrap().0;
    assert_eq!(native.name, "A");
    assert!(native.scheduled_by.is_none());
    assert_eq!(prior_nodes[&hq].0.headcount, 2);
    assert_eq!(
        prior_nodes[&setup.units[1].org_unit_id].0.direct_headcount,
        1
    );
    let prior_dates = store
        .structure_change_dates(&scoped, today, range_end, historical)
        .await
        .unwrap();
    assert!(!prior_dates.contains(&departure.to_string()));
    assert!(!prior_dates.contains(&hidden_rename.to_string()));
}

#[path = "asof_ribbon_scope/transient.rs"]
mod transient;
