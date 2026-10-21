#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Same full-chart workload for lane/trunk: 300 units, 2,000 assigned people, lifecycle facts.
//! Baseline reference: git show console-react-mvp:backend/crates/entity/adapter-postgres/src/structure.rs.
//! Run `structure_300_units_2000_people_today_p95` with pgtest-nextest and captured output.
//! Compare its measured p95 with that test on the actual trunk implementation; no proxy ratio.
mod common;
use common::*;
use console_entity_adapter_postgres::PgEntityStore;
use console_entity_application::{Actor, OrgStructure, ReadOptions};
use console_ontology_canonical_adapter_postgres::org_unit::{
    OrgUnitCommand, OrgUnitQuery, write_in_tx,
};
use console_ontology_canonical_domain::CommandId;
use serde_json::json;
use sqlx::PgPool;
use std::time::Instant;
use time::{Date, Duration, OffsetDateTime};
use uuid::Uuid;

struct World {
    store: PgEntityStore,
    actor: Actor,
    today: Date,
    known: OffsetDateTime,
    workplaces: [Uuid; 2],
    counts: [i64; 2],
    dispatched: [i64; 2],
}

async fn world(owner: &PgPool) -> World {
    let (store, actor) = tenant(owner, Uuid::new_v4(), "asof-load").await;
    let today: Date = sqlx::query_scalar("SELECT (now() AT TIME ZONE 'Asia/Seoul')::date")
        .fetch_one(owner)
        .await
        .unwrap();
    let (entity, [(hq, hq_site), (plant, plant_site)]) = two_workplaces(&store, &actor).await;
    let workplaces = [hq, plant];
    let sites = [hq_site, plant_site];
    let mut units = Vec::new();
    let mut unit_workplaces = Vec::new();
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(actor.org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    for n in 0..298 {
        let at = (n / 5) % 2;
        let parent = if n % 5 == 0 { sites[at] } else { units[n - 1] };
        let command = OrgUnitCommand {
            org_id: actor.org,
            actor_id: actor.user,
            command_id: CommandId::from_uuid(Uuid::new_v4()),
            query: OrgUnitQuery::Create {
                source: None,
                attributes: json!({
                    "name":format!("Unit {n:03}"),"kind":"department","parent_id":parent,
                    "status":"active","effective_from":(today-Duration::days(100)).to_string(),
                }),
            },
            action_key: "internal.setup.test_org_unit".into(),
            object_type_id: Uuid::nil(),
        };
        let receipt = write_in_tx(&mut tx, &command).await.unwrap();
        units.push(Uuid::parse_str(receipt.result()["org_unit_id"].as_str().unwrap()).unwrap());
        unit_workplaces.push(workplaces[at]);
    }
    tx.commit().await.unwrap();
    let people: Vec<_> = (0..2000).map(|_| Uuid::new_v4()).collect();
    let mut person_units = Vec::new();
    let mut person_workplaces = Vec::new();
    let mut types = Vec::new();
    let mut counts = [0_i64; 2];
    let mut dispatched = [0_i64; 2];
    for n in 0..2000 {
        // 200 source members: 100 lifecycle moves and 100 approved subset reassignments.
        let u = if n < 200 { 0 } else { n % units.len() };
        let at = usize::from(unit_workplaces[u] == plant);
        person_units.push(units[u]);
        person_workplaces.push(workplaces[at]);
        counts[at] += 1;
        let external = n % 10 == 0;
        dispatched[at] += i64::from(external);
        types.push(if external { "DISPATCHED_IN" } else { "REGULAR" });
    }
    sqlx::query(
        "INSERT INTO employees (id,org_id,company,name,employment_status,org_unit_id,hire_date, \
         source_filename,source_sheet,source_row,source_key) \
         SELECT id,$1,'Load Corp','Person '||n,'ACTIVE',unit,$4::text,'test','test',n::integer,id::text \
         FROM unnest($2::uuid[],$3::uuid[]) WITH ORDINALITY AS p(id,unit,n)",
    ).bind(*actor.org.as_uuid()).bind(&people).bind(&person_units)
        .bind((today-Duration::days(60)).to_string()).execute(owner).await.unwrap();
    sqlx::query(
        "INSERT INTO employee_employment_profiles (employee_id,org_id,employment_type,phone_e164, \
         base_pay,idempotency_key,request_hash,created_by) \
         SELECT id,$1,kind,'+821012345678',0,id::text,repeat('a',64),$4 \
         FROM unnest($2::uuid[],$3::text[]) AS p(id,kind)",
    )
    .bind(*actor.org.as_uuid())
    .bind(&people)
    .bind(&types)
    .bind(*actor.user.as_uuid())
    .execute(owner)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO employment_assignments (org_id,employee_id,legal_entity_id,workplace_id, \
         valid_from,cause,command_id) SELECT $1,id,$4,workplace,$5,'MIGRATION',gen_random_uuid() \
         FROM unnest($2::uuid[],$3::uuid[]) AS p(id,workplace)",
    )
    .bind(*actor.org.as_uuid())
    .bind(&people)
    .bind(&person_workplaces)
    .bind(entity)
    .bind(today - Duration::days(60))
    .execute(owner)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO employee_lifecycle_events (org_id,employee_id,event_type,from_status,to_status, \
         to_org_unit_id,to_org_unit,effective_date,comment,created_by,state) \
         SELECT $1,id,'ONBOARD','PRE_HIRE','ACTIVE',unit,unit::text,$4,'Initial onboarding',$5,'APPLIED' \
         FROM unnest($2::uuid[],$3::uuid[]) AS p(id,unit)",
    ).bind(*actor.org.as_uuid()).bind(&people).bind(&person_units)
        .bind((today-Duration::days(60)).to_string()).bind(*actor.user.as_uuid())
        .execute(owner).await.unwrap();
    let known: OffsetDateTime = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(owner)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO employee_lifecycle_events (org_id,employee_id,event_type,from_status,to_status, \
         from_org_unit_id,to_org_unit_id,from_org_unit,to_org_unit,to_workplace_id,effective_date, \
         comment,created_by,state) SELECT $1,id,'TRANSFER','ACTIVE','ACTIVE',$3,$4,$3::text,$4::text,$5,$6, \
         'Scheduled transfer',$7,'SCHEDULED' FROM unnest($2::uuid[]) AS p(id)",
    ).bind(*actor.org.as_uuid()).bind(&people[..100]).bind(units[0]).bind(units[5])
        .bind(plant).bind((today+Duration::days(30)).to_string()).bind(*actor.user.as_uuid())
        .execute(owner).await.unwrap();
    let change = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO org_change_requests (id,org_id,code,kind,status,target_kind,target_ref,target_label, \
         effective_date,reason,proposal,drafted_by,idempotency_key,request_fingerprint) \
         VALUES ($1,$2,'OC-2026-0001','REORG','APPROVED','ORG_UNIT',$3,'Source',$4,'Load projection',$5,$6,$1::text,repeat('0',64))",
    ).bind(change).bind(*actor.org.as_uuid()).bind(units[0].to_string())
        .bind(today+Duration::days(30)).bind(json!([{
            "op":"REASSIGN_ORG_UNIT","fromOrgUnit":units[0],"toOrgUnit":units[5],
            "scope":{"company":"Load Corp"},"employeeIds":people[100..200],
        }])).bind(*actor.user.as_uuid()).execute(owner).await.unwrap();
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM org_units WHERE org_id=$1")
        .bind(*actor.org.as_uuid())
        .fetch_one(owner)
        .await
        .unwrap();
    assert_eq!(total, 300);
    World {
        store,
        actor,
        today,
        known,
        workplaces,
        counts,
        dispatched,
    }
}

fn assert_counts(tree: &OrgStructure, w: &World, counts: [i64; 2], dispatched: [i64; 2]) {
    let entity = &tree.entities[0];
    assert_eq!(entity.headcount, 2000);
    assert_eq!(entity.dispatched_headcount, 200);
    assert_eq!(tree.entity_unknown_headcount, Some(0));
    for n in 0..2 {
        let workplace = entity
            .children
            .iter()
            .find(|p| p.id == w.workplaces[n])
            .unwrap();
        assert_eq!(
            (workplace.headcount, workplace.dispatched_headcount),
            (counts[n], dispatched[n])
        );
    }
    fn direct(nodes: &[console_entity_application::OrgStructureNode]) -> (i64, usize) {
        nodes.iter().fold((0, 0), |sum, n| {
            let children = direct(&n.children);
            (
                sum.0 + n.direct_headcount + children.0,
                sum.1 + 1 + children.1,
            )
        })
    }
    let department_counts: Vec<_> = entity
        .children
        .iter()
        .map(|p| direct(&p.children))
        .collect();
    assert_eq!(department_counts.iter().map(|p| p.0).sum::<i64>(), 2000);
    assert_eq!(department_counts.iter().map(|p| p.1).sum::<usize>(), 298);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn structure_300_units_2000_people_today_p95(owner: PgPool) {
    let w = world(&owner).await;
    for _ in 0..4 {
        assert_counts(
            &w.store.org_structure(&w.actor).await.unwrap(),
            &w,
            w.counts,
            w.dispatched,
        );
    }
    let mut samples = Vec::new();
    for _ in 0..31 {
        let start = Instant::now();
        let tree = w.store.org_structure(&w.actor).await.unwrap();
        samples.push(start.elapsed().as_micros());
        assert_counts(&tree, &w, w.counts, w.dispatched);
    }
    samples.sort_unstable();
    println!(
        "ASOF_FULL_CHART units=300 people=2000 warmup=4 samples=31 p95_us={}",
        samples[29]
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn structure_300_units_2000_people_future_and_known_counts(owner: PgPool) {
    let w = world(&owner).await;
    let future = w.today + Duration::days(30);
    let today = w.store.org_structure(&w.actor).await.unwrap();
    assert_counts(&today, &w, w.counts, w.dispatched);
    let projected = w
        .store
        .org_structure_at(
            &w.actor,
            ReadOptions {
                as_of: Some(future),
                known_at: None,
            },
        )
        .await
        .unwrap();
    assert_counts(
        &projected,
        &w,
        [w.counts[0] - 200, w.counts[1] + 200],
        [w.dispatched[0] - 20, w.dispatched[1] + 20],
    );
    let prior = w
        .store
        .org_structure_at(
            &w.actor,
            ReadOptions {
                as_of: Some(future),
                known_at: Some(w.known),
            },
        )
        .await
        .unwrap();
    assert_counts(&prior, &w, w.counts, w.dispatched);
}
