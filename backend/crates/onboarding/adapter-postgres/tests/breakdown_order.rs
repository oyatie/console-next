#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The go-live breakdown and the records under each preview line list 법인 and
//! their 사업장 in the stored order, never by id or name.
mod common;
use common::*;
use console_onboarding_adapter_postgres::{OnboardingActor, PgOnboardingStore};
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

async fn entity(tx: &mut PgConnection, org: Uuid, name: &str, order: Option<i32>) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO legal_entities (org_id,id,sort_order,needs_confirmation,created_change_mode) VALUES ($1,$2,$3,true,'MIGRATION')")
        .bind(org).bind(id).bind(order).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO legal_entity_revisions (org_id,legal_entity_id,version,command_id,effective_from,name,change_mode,reason_code,payload_digest,settings_snapshot) VALUES ($1,$2,1,gen_random_uuid(),'2020-01-01',$3,'MIGRATION','CREATE',sha256('x'::bytea),'{}')")
        .bind(org).bind(id).bind(name).execute(&mut *tx).await.unwrap();
    id
}

async fn site(
    tx: &mut PgConnection,
    org: Uuid,
    entity: Uuid,
    name: &str,
    order: Option<i32>,
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO workplaces (org_id,id,legal_entity_id,sort_order,needs_confirmation,created_change_mode) VALUES ($1,$2,$3,$4,true,'MIGRATION')")
        .bind(org).bind(id).bind(entity).bind(order).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO workplace_revisions (org_id,workplace_id,version,command_id,effective_from,name,status,change_mode,reason_code,payload_digest,settings_snapshot) VALUES ($1,$2,1,gen_random_uuid(),'2020-01-01',$3,'CONTINUING','MIGRATION','test',sha256('x'::bytea),'{}')")
        .bind(org).bind(id).bind(name).execute(&mut *tx).await.unwrap();
    id
}

/// Stored order runs against name order at both levels; the unpositioned
/// ones come after the ordered ones. Returns the store, its actor, the 법인 in
/// stored order and the 사업장 in stored order.
async fn seeded(owner: &PgPool) -> (PgOnboardingStore, OnboardingActor, [Uuid; 3], [Uuid; 4]) {
    let (store, a) = tenant(owner).await;
    let org = *a.org.as_uuid();
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    let last = entity(&mut tx, org, "가법인", None).await;
    let na = entity(&mut tx, org, "나법인", Some(0)).await;
    let ga = entity(&mut tx, org, "다법인", Some(1)).await;
    let da = site(&mut tx, org, na, "다사업장", Some(1)).await;
    let ra = site(&mut tx, org, na, "라사업장", Some(0)).await;
    let sa = site(&mut tx, org, ga, "가사업장", None).await;
    let aa = site(&mut tx, org, ga, "아사업장", Some(0)).await;
    tx.commit().await.unwrap();
    (store, a, [na, ga, last], [ra, da, aa, sa])
}

fn strings(ids: &[Uuid]) -> Vec<String> {
    ids.iter().map(Uuid::to_string).collect()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn go_live_breakdown_follows_the_stored_order(owner: PgPool) {
    let (store, a, [na, ga, last], [ra, da, aa, sa]) = seeded(&owner).await;
    let got: Vec<String> = store
        .preview(&a)
        .await
        .unwrap()
        .details
        .breakdown
        .into_iter()
        .map(|b| b.id)
        .collect();
    assert_eq!(got, strings(&[na, ra, da, ga, aa, sa, last]));
}

/// The records under each preview line (go-live-items) follow the same order
/// as the breakdown above them, never the name.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn go_live_line_records_follow_the_stored_order(owner: PgPool) {
    let (store, a, entities, workplaces) = seeded(&owner).await;
    let p = store.preview(&a).await.unwrap();
    let records = |code: &str| -> Vec<String> {
        p.blockers
            .iter()
            .chain(&p.warnings)
            .find(|i| i.code == code)
            .unwrap_or_else(|| panic!("no {code} line"))
            .records
            .iter()
            .map(|r| r.id.clone())
            .collect()
    };
    assert_eq!(records("entity_needs_confirmation"), strings(&entities));
    assert_eq!(records("workplace_incomplete"), strings(&workplaces));
}
