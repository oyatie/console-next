#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The /statutory 사업장 picker lists in the stored order (법인, then its 사업장), never by name.
mod support;
#[path = "statutory/world.rs"]
mod world;
use sqlx::PgPool;
use support::principal;
use uuid::Uuid;
use world::world;

async fn entity(tx: &mut sqlx::PgConnection, org: Uuid, name: &str, order: Option<i32>) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO legal_entities (org_id,id,sort_order,needs_confirmation,created_change_mode) VALUES ($1,$2,$3,true,'MIGRATION')")
        .bind(org).bind(id).bind(order).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO legal_entity_revisions (org_id,legal_entity_id,version,command_id,effective_from,name,change_mode,reason_code,payload_digest,settings_snapshot) VALUES ($1,$2,1,gen_random_uuid(),'2020-01-01',$3,'MIGRATION','CREATE',sha256('x'::bytea),'{}')")
        .bind(org).bind(id).bind(name).execute(&mut *tx).await.unwrap();
    id
}

async fn site(
    tx: &mut sqlx::PgConnection,
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

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn statutory_workplace_picker_follows_the_stored_order_not_names(pool: PgPool) {
    let w = world(&pool).await;
    let org = w.tenant.org;
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    // Stored order runs against name order at both levels; one 사업장 has no stored position (after the ordered ones).
    let na = entity(&mut tx, org, "나법인", Some(0)).await;
    let ga = entity(&mut tx, org, "가법인", Some(1)).await;
    let da = site(&mut tx, org, na, "다사업장", Some(1)).await;
    let ra = site(&mut tx, org, na, "라사업장", Some(0)).await;
    let sa = site(&mut tx, org, ga, "사사업장", None).await;
    let aa = site(&mut tx, org, ga, "아사업장", Some(0)).await;
    tx.commit().await.unwrap();
    let got: Vec<Uuid> = w
        .tenant
        .hr
        .statutory_workplaces(principal(org, w.user), None)
        .await
        .unwrap()
        .into_iter()
        .map(|x| x.id)
        .collect();
    // The world's own 법인 has no stored position, so it and its 사업장 come last.
    assert_eq!(got, vec![ra, da, aa, sa, w.site]);
}
