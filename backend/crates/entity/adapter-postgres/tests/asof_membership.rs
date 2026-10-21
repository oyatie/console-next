#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Regressions for scoped projections, native assignment corrections and rehire history.
mod common;
use common::*;
use console_entity_adapter_postgres::PgEntityStore;
use console_entity_application::{Actor, BindAssignment, EntityScope, OrgStructure, ReadOptions};
use console_ontology_canonical_adapter_postgres::{
    employee_intake::{RehirePeriod, start_rehire_period},
    org_unit::{OrgUnitCommand, OrgUnitQuery, write_in_tx},
};
use console_ontology_canonical_domain::CommandId;
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Date, Duration, OffsetDateTime};
use uuid::Uuid;

#[path = "asof_membership/exits.rs"]
mod exits;

struct World {
    store: PgEntityStore,
    actor: Actor,
    d: Date,
    entity: Uuid,
    workplaces: [Uuid; 2],
    sites: [Uuid; 2],
    units: [Uuid; 2],
}
async fn source_person(owner: &PgPool, w: &World, key: &str) -> Uuid {
    person(
        owner,
        &w.store,
        &w.actor,
        (w.entity, w.workplaces[0], w.units[0]),
        key,
    )
    .await
}
async fn revise(owner: &PgPool, a: &Actor, id: Uuid, attrs: Value) {
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(a.org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    write_in_tx(
        &mut tx,
        &OrgUnitCommand {
            org_id: a.org,
            actor_id: a.user,
            command_id: CommandId::from_uuid(Uuid::new_v4()),
            query: OrgUnitQuery::Revise {
                org_unit_id: id,
                source: None,
                attributes: attrs,
            },
            action_key: "internal.setup.test_org_unit".into(),
            object_type_id: Uuid::nil(),
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
}
async fn world(owner: &PgPool, tag: &str) -> World {
    let (store, actor) = tenant(owner, Uuid::new_v4(), tag).await;
    let d: Date = sqlx::query_scalar("SELECT (now() AT TIME ZONE 'Asia/Seoul')::date")
        .fetch_one(owner)
        .await
        .unwrap();
    let (entity, [(hq, hq_site), (plant, plant_site)]) = two_workplaces(&store, &actor).await;
    let receipt = store
        .apply_org_setup_batch(
            &cmd(&actor),
            vec![
                under_workplace("a", "A", hq),
                under_workplace("b", "B", plant),
            ],
            port(),
        )
        .await
        .unwrap();
    let w = World {
        store,
        actor,
        d,
        entity,
        workplaces: [hq, plant],
        sites: [hq_site, plant_site],
        units: [receipt.units[0].org_unit_id, receipt.units[1].org_unit_id],
    };
    for n in 0..2 {
        revise(
            owner,
            &w.actor,
            w.sites[n],
            json!({"name":"Site","kind":"site","status":"active",
            "effective_from":(d-Duration::days(200)).to_string()}),
        )
        .await;
        unit(owner, &w, n, d - Duration::days(200), w.sites[n], "Unit").await;
    }
    w
}
async fn unit(owner: &PgPool, w: &World, n: usize, date: Date, parent: Uuid, name: &str) {
    revise(
        owner,
        &w.actor,
        w.units[n],
        json!({"name":name,"kind":"department",
        "parent_id":parent,"status":"active","effective_from":date.to_string()}),
    )
    .await;
}
fn has_unit(tree: &OrgStructure, id: Uuid) -> bool {
    tree.entities[0].children[0]
        .children
        .iter()
        .any(|n| n.id == id)
}
async fn known(owner: &PgPool) -> OffsetDateTime {
    sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(owner)
        .await
        .unwrap()
}
async fn lifecycle(owner: &PgPool, w: &World, p: Uuid, kind: &str, date: Date) {
    // Fixture transfers enter HQ; rehiring starts in Plant, and termination clears placement.
    let to = (kind != "TERMINATE").then_some(w.units[usize::from(kind == "REHIRE")]);
    let from = (kind != "ONBOARD").then_some(w.units[usize::from(kind == "TRANSFER")]);
    let wp = to.map(|_| w.workplaces[usize::from(kind == "REHIRE")]);
    sqlx::query("INSERT INTO employee_lifecycle_events (org_id,employee_id,event_type,from_status,to_status, \
        from_org_unit_id,to_org_unit_id,from_org_unit,to_org_unit,to_workplace_id,effective_date,comment,created_by,state) \
        VALUES ($1,$2,$3,CASE $3 WHEN 'ONBOARD' THEN 'PRE_HIRE' WHEN 'REHIRE' THEN 'EXITED' ELSE 'ACTIVE' END, \
        CASE $3 WHEN 'TERMINATE' THEN 'EXITED' ELSE 'ACTIVE' END,$4,$5,$4::text,$5::text,$6,$7::date::text, \
        'Temporal fixture',$8,CASE WHEN $7 > $9 OR $3='TERMINATE' AND $7=$9 THEN 'SCHEDULED' ELSE 'APPLIED' END)")
        .bind(*w.actor.org.as_uuid()).bind(p).bind(kind).bind(from).bind(to).bind(wp)
        .bind(date).bind(*w.actor.user.as_uuid()).bind(w.d).execute(owner).await.unwrap();
}
async fn read(
    w: &World,
    actor: &Actor,
    date: Date,
    known_at: Option<OffsetDateTime>,
) -> OrgStructure {
    w.store
        .org_structure_at(
            actor,
            ReadOptions {
                as_of: Some(date),
                known_at,
            },
        )
        .await
        .unwrap()
}
fn counts(tree: &OrgStructure, w: &World) -> [i64; 2] {
    std::array::from_fn(|n| {
        tree.entities[0]
            .children
            .iter()
            .find(|p| p.id == w.workplaces[n])
            .map_or(0, |p| p.headcount)
    })
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn projected_people_leaving_scope_are_not_counted_at_old_workplace(owner: PgPool) {
    let w = world(&owner, "asof-cross-scope").await;
    let p = source_person(&owner, &w, "moving").await;
    source_person(&owner, &w, "staying").await;
    let cutoff = known(&owner).await;
    let change = Uuid::new_v4();
    sqlx::query("INSERT INTO org_change_requests (id,org_id,code,kind,status,target_kind,target_ref,target_label, \
        effective_date,reason,proposal,drafted_by,idempotency_key,request_fingerprint) \
        VALUES ($1,$2,'OC-2026-0001','REORG','APPROVED','ORG_UNIT',$3,'A',$4,'Scope projection',$5,$6,$1::text,repeat('0',64))")
        .bind(change).bind(*w.actor.org.as_uuid()).bind(w.units[0].to_string()).bind(w.d+Duration::days(10))
        .bind(json!([{"op":"REASSIGN_ORG_UNIT","fromOrgUnit":w.units[0],"toOrgUnit":w.units[1],
            "scope":{"company":"audit"},"employeeIds":[p]}]))
        .bind(*w.actor.user.as_uuid()).execute(&owner).await.unwrap();
    let scoped = Actor {
        scope: EntityScope::Only(vec![w.workplaces[0]]),
        ..w.actor.clone()
    };
    let date = w.d + Duration::days(10);
    assert_eq!(counts(&read(&w, &w.actor, date, None).await, &w), [1, 1]);
    let projected = read(&w, &scoped, date, None).await;
    assert_eq!(projected.entities[0].children.len(), 1);
    assert_eq!(counts(&projected, &w), [1, 0]);
    assert_eq!(
        counts(&read(&w, &scoped, date, Some(cutoff)).await, &w),
        [2, 0]
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn newer_native_assignment_correction_wins_over_an_older_lifecycle_workplace(owner: PgPool) {
    let w = world(&owner, "asof-assignment-precedence").await;
    let p = source_person(&owner, &w, "corrected").await;
    let effective = w.d - Duration::days(10);
    lifecycle(&owner, &w, p, "TRANSFER", effective).await;
    let assignment = |wp| BindAssignment {
        employee_id: p,
        legal_entity_id: Some(w.entity),
        workplace_id: Some(wp),
        valid_from: Some(effective.to_string()),
    };
    w.store
        .bind_assignment(&cmd(&w.actor), assignment(w.workplaces[0]))
        .await
        .unwrap();
    let cutoff = known(&owner).await;
    // Correct the department's placement too: an assignment never contradicts its department.
    unit(&owner, &w, 0, effective, w.sites[1], "Unit").await;
    let corrected = w
        .store
        .bind_assignment(&cmd(&w.actor), assignment(w.workplaces[1]))
        .await
        .unwrap();
    assert_eq!(corrected.cause, "CORRECTION");
    assert_eq!(counts(&read(&w, &w.actor, w.d, None).await, &w), [0, 1]);
    assert_eq!(
        counts(&read(&w, &w.actor, w.d, Some(cutoff)).await, &w),
        [1, 0]
    );
    let future = w.d + Duration::days(30);
    assert_eq!(counts(&read(&w, &w.actor, future, None).await, &w), [0, 1]);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rehire_keeps_original_employment_in_past_and_known_counts(owner: PgPool) {
    let w = world(&owner, "asof-rehire").await;
    let p = source_person(&owner, &w, "rehired").await;
    lifecycle(&owner, &w, p, "ONBOARD", w.d - Duration::days(100)).await;
    lifecycle(&owner, &w, p, "TERMINATE", w.d - Duration::days(60)).await;
    sqlx::query("UPDATE employees SET employment_status='EXITED',exit_date=$2 WHERE id=$1")
        .bind(p)
        .bind((w.d - Duration::days(60)).to_string())
        .execute(&owner)
        .await
        .unwrap();
    let cutoff = known(&owner).await;
    let mut tx = owner.begin().await.unwrap();
    let hire = (w.d - Duration::days(10)).to_string();
    assert!(
        start_rehire_period(
            &mut tx,
            *w.actor.org.as_uuid(),
            p,
            &RehirePeriod {
                employment_status: "ACTIVE",
                hire_date: &hire,
                company: "Rehire Corp",
                org_unit: "B",
                org_unit_id: w.units[1],
                position: "Staff",
            }
        )
        .await
        .unwrap()
    );
    tx.commit().await.unwrap();
    lifecycle(&owner, &w, p, "REHIRE", w.d - Duration::days(10)).await;
    let past = w.d - Duration::days(80);
    assert_eq!(counts(&read(&w, &w.actor, past, None).await, &w), [1, 0]);
    assert_eq!(
        counts(&read(&w, &w.actor, past, Some(cutoff)).await, &w),
        [1, 0]
    );
    for (date, expected) in [
        (w.d - Duration::days(101), [0, 0]),
        (w.d - Duration::days(100), [1, 0]),
        (w.d - Duration::days(11), [0, 0]),
        (w.d - Duration::days(10), [0, 1]),
    ] {
        let tree = read(&w, &w.actor, date, None).await;
        assert_eq!(counts(&tree, &w), expected);
        assert_eq!(tree.entity_unknown_headcount, Some(0));
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scoped_change_dates_use_overlapping_latest_known_parent_windows(owner: PgPool) {
    let w = world(&owner, "asof-ribbon-scope").await;
    let move_date = w.d + Duration::days(5);
    unit(&owner, &w, 0, move_date, w.sites[0], "Visible").await;
    let cutoff = known(&owner).await;
    unit(&owner, &w, 0, move_date, w.sites[1], "Moved").await;
    let rename_date = w.d + Duration::days(20);
    unit(&owner, &w, 0, rename_date, w.sites[1], "Hidden rename").await;
    let scoped = Actor {
        scope: EntityScope::Only(vec![w.workplaces[0]]),
        ..w.actor.clone()
    };
    let dates = w
        .store
        .structure_change_dates(
            &scoped,
            w.d,
            w.d + Duration::days(30),
            ReadOptions::default(),
        )
        .await
        .unwrap();
    assert!(dates.contains(&move_date.to_string()));
    assert!(!dates.contains(&rename_date.to_string()));
    let selected = w.d + Duration::days(15);
    let before = read(&w, &scoped, selected, Some(cutoff)).await;
    let after = read(&w, &scoped, selected, None).await;
    assert!(has_unit(&before, w.units[0]));
    assert!(!has_unit(&after, w.units[0]));
}
