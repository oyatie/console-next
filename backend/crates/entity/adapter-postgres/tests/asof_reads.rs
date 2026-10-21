#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Dated chart and record reads, corrections, scheduled people movement and current scope.
mod common;
use common::*;
use console_entity_adapter_postgres::PgEntityStore;
use console_entity_application::{AsOfQuery, EntityScope, LegalEntityRevision, ReadOptions};
use console_ontology_canonical_adapter_postgres::org_unit::{
    OrgUnitCommand, OrgUnitQuery, write_in_tx,
};
use console_ontology_canonical_domain::CommandId;
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Date, Duration, OffsetDateTime};
use uuid::Uuid;

async fn today(owner: &PgPool) -> Date {
    sqlx::query_scalar("SELECT (now() AT TIME ZONE 'Asia/Seoul')::date")
        .fetch_one(owner)
        .await
        .unwrap()
}
async fn revise_unit(
    owner: &PgPool,
    actor: &console_entity_application::Actor,
    id: Uuid,
    attrs: Value,
) {
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(actor.org.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let cmd = OrgUnitCommand {
        org_id: actor.org,
        actor_id: actor.user,
        command_id: CommandId::from_uuid(Uuid::new_v4()),
        query: OrgUnitQuery::Revise {
            org_unit_id: id,
            source: None,
            attributes: attrs,
        },
        action_key: "internal.setup.test_org_unit".into(),
        object_type_id: Uuid::nil(),
    };
    write_in_tx(&mut tx, &cmd).await.unwrap();
    tx.commit().await.unwrap();
}
async fn read(
    store: &PgEntityStore,
    actor: &console_entity_application::Actor,
    date: Date,
) -> console_entity_application::OrgStructure {
    store
        .org_structure_at(
            actor,
            ReadOptions {
                as_of: Some(date),
                known_at: None,
            },
        )
        .await
        .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn dated_rename_and_later_correction_keep_prior_effective_and_known_values(owner: PgPool) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "asof-record").await;
    let d = today(&owner).await;
    let mut original = corporation("Original", "000211-0006241");
    original.incorporated_on = Some((d - Duration::days(100)).to_string());
    let e = store
        .create_entity(&cmd(&actor), original)
        .await
        .unwrap()
        .record
        .id;
    let revision = |version, name: &str| LegalEntityRevision {
        expected_version: Some(version),
        effective_from: Some((d - Duration::days(10)).to_string()),
        reason_code: Some("RENAME".into()),
        input: corporation(name, "000211-0006241"),
    };
    store
        .revise_entity(&cmd(&actor), e, revision(1, "Renamed"))
        .await
        .unwrap();
    let known: OffsetDateTime = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&owner)
        .await
        .unwrap();
    store
        .revise_entity(&cmd(&actor), e, revision(2, "Corrected"))
        .await
        .unwrap();
    let effective = store
        .get_entity_at(
            &actor,
            e,
            false,
            ReadOptions {
                as_of: Some(d - Duration::days(11)),
                known_at: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(effective.current.unwrap().name, "Original");
    assert!(effective.read.read_only);
    let prior = store
        .get_entity_at(
            &actor,
            e,
            false,
            ReadOptions {
                as_of: Some(d),
                known_at: Some(known),
            },
        )
        .await
        .unwrap();
    assert_eq!(prior.current.unwrap().name, "Renamed");
    assert_eq!(
        store
            .get_entity_at(&actor, e, false, ReadOptions::default())
            .await
            .unwrap()
            .current
            .unwrap()
            .name,
        "Corrected"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn chart_rename_diff_and_change_dates_share_the_effective_timeline(owner: PgPool) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "asof-chart").await;
    let d = today(&owner).await;
    let (_, [(_, site), _]) = two_workplaces(&store, &actor).await;
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(actor.org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let id = port().write(&mut tx, actor.org, actor.user, Uuid::new_v4(), None,
        json!({"name":"Old","kind":"department","parent_id":site,"status":"active","effective_from":(d-Duration::days(30)).to_string()})).await.unwrap();
    tx.commit().await.unwrap();
    // The parent and its placement existed before the two dated department revisions.
    revise_unit(&owner, &actor, site, json!({"name":"HQ", "kind":"site", "status":"active", "effective_from":(d-Duration::days(100)).to_string()})).await;
    sqlx::query("INSERT INTO org_unit_placements (org_id,org_unit_id,legal_entity_id,workplace_id,valid_from,valid_to,represents_workplace,change_mode,actor_id,command_id) SELECT org_id,org_unit_id,legal_entity_id,workplace_id,$2,valid_from,true,'MIGRATION',NULL,gen_random_uuid() FROM org_unit_placements WHERE org_unit_id=$1")
        .bind(site)
        .bind(d - Duration::days(100))
        .execute(&owner)
        .await
        .unwrap();
    let attrs = |name: &str, date: Date| json!({"name":name,"kind":"department","parent_id":site,"status":"active","effective_from":date.to_string()});
    revise_unit(&owner, &actor, id, attrs("Old", d - Duration::days(30))).await;
    revise_unit(&owner, &actor, id, attrs("New", d - Duration::days(10))).await;
    assert_eq!(
        read(&store, &actor, d - Duration::days(11)).await.entities[0].children[0].children[0].name,
        "Old"
    );
    let diff = store
        .structure_diff(&actor, d - Duration::days(11), d, ReadOptions::default())
        .await
        .unwrap();
    assert!(
        diff.marks
            .iter()
            .any(|n| n.id == id && n.marks == ["renamed"])
    );
    let dates = store
        .structure_change_dates(&actor, d - Duration::days(31), d, ReadOptions::default())
        .await
        .unwrap();
    assert!(dates.contains(&(d - Duration::days(10)).to_string()));
    assert!(
        read(&store, &actor, d - Duration::days(11)).await.entities[0].children[0].children[0]
            .changed_after
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn future_subset_people_move_with_units_and_rescheduled_known_at_stays_stable(owner: PgPool) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "asof-future").await;
    let d = today(&owner).await;
    let (entity, [(w, site), (other, other_site)]) = two_workplaces(&store, &actor).await;
    let receipt = store
        .apply_org_setup_batch(
            &cmd(&actor),
            vec![
                under_workplace("a", "A", w),
                under_workplace("b", "B", other),
            ],
            port(),
        )
        .await
        .unwrap();
    let (a, b) = (receipt.units[0].org_unit_id, receipt.units[1].org_unit_id);
    let p = person(&owner, &store, &actor, (entity, w, a), "moving").await;
    person(&owner, &store, &actor, (entity, w, a), "staying").await;
    let change = Uuid::new_v4();
    sqlx::query("INSERT INTO org_change_requests (id,org_id,code,kind,status,target_kind,target_ref,target_label,effective_date,reason,proposal,drafted_by,idempotency_key,request_fingerprint) VALUES ($1,$2,'OC-2026-0001','REORG','APPROVED','ORG_UNIT',$3,'A',$4,'future',$5,$6,$1::text,repeat('0',64))")
        .bind(change).bind(*actor.org.as_uuid()).bind(a.to_string()).bind(d+Duration::days(10))
        .bind(json!([{"op":"REASSIGN_ORG_UNIT","fromOrgUnit":a,"toOrgUnit":b,"scope":{"company":"주식회사 가나"},"employeeIds":[p]}, {"op":"CREATE_ORG_UNIT","kind":"DEPARTMENT","parentId":site,"name":"Scheduled"}]))
        .bind(*actor.user.as_uuid()).execute(&owner).await.unwrap();
    let known: OffsetDateTime = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&owner)
        .await
        .unwrap();
    let future = read(&store, &actor, d + Duration::days(10)).await;
    assert_eq!(
        future.entities[0]
            .children
            .iter()
            .map(|w| w.headcount)
            .collect::<Vec<_>>(),
        [1, 1]
    );
    assert!(future.entities[0].children[0].children.iter().any(|n| {
        n.name == "Scheduled"
            && n.scheduled_by
                .as_ref()
                .is_some_and(|s| s.change_id == change)
    }));
    assert_eq!(future.entities[0].children[1].org_unit_id, Some(other_site));
    sqlx::query("UPDATE org_change_requests SET effective_date=$2 WHERE id=$1")
        .bind(change)
        .bind(d + Duration::days(20))
        .execute(&owner)
        .await
        .unwrap();
    let prior = store
        .org_structure_at(
            &actor,
            ReadOptions {
                as_of: Some(d + Duration::days(10)),
                known_at: Some(known),
            },
        )
        .await
        .unwrap();
    assert_eq!(prior.entities[0].children[1].headcount, 1);
    assert_eq!(
        read(&store, &actor, d + Duration::days(10)).await.entities[0].children[1].headcount,
        0
    );
    // An earlier-known approval is replayed even once its effective date is today/past.
    sqlx::query("UPDATE org_change_requests SET effective_date=$2 WHERE id=$1")
        .bind(change)
        .bind(d)
        .execute(&owner)
        .await
        .unwrap();
    let before_reschedule: OffsetDateTime = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&owner)
        .await
        .unwrap();
    sqlx::query("UPDATE org_change_requests SET effective_date=$2 WHERE id=$1")
        .bind(change)
        .bind(d + Duration::days(20))
        .execute(&owner)
        .await
        .unwrap();
    let earlier = store
        .org_structure_at(
            &actor,
            ReadOptions {
                as_of: Some(d),
                known_at: Some(before_reschedule),
            },
        )
        .await
        .unwrap();
    assert_eq!(earlier.entities[0].children[1].headcount, 1);
    assert_eq!(
        read(&store, &actor, d).await.entities[0].children[1].headcount,
        0
    );
    let scoped = console_entity_application::Actor {
        scope: EntityScope::Only(vec![w]),
        ..actor.clone()
    };
    let hidden = read(&store, &scoped, d + Duration::days(20)).await;
    assert_eq!(hidden.entities[0].children.len(), 1);
    assert_eq!(hidden.entities[0].headcount, 1);
    assert_eq!(hidden.entity_unknown_headcount, None);
    assert!(
        AsOfQuery {
            as_of: Some("2026-02-30".into()),
            known_at: None
        }
        .parse()
        .is_err()
    );
}
