#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Compare marks link their own change sets, including the canonical IDs minted at apply.
mod common;
use common::*;
use console_entity_application::{Actor, ReadOptions};
use console_orgchange_domain::projection::projected_unit_id;
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Date, Duration, OffsetDateTime};
use uuid::Uuid;

async fn request(
    owner: &PgPool,
    actor: &Actor,
    target: Uuid,
    n: usize,
    due: Date,
    op: Value,
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO org_change_requests (id,org_id,code,kind,status,target_kind,target_ref,target_label, \
        effective_date,reason,proposal,drafted_by,idempotency_key,request_fingerprint) \
        VALUES ($1,$2,$3,'REORG','APPROVED','ORG_UNIT',$4,'Target',$5,'Attribution',$6,$7,$1::text,repeat('0',64))")
        .bind(id).bind(*actor.org.as_uuid()).bind(format!("OC-2026-{n:04}")).bind(target.to_string())
        .bind(due).bind(json!([op])).bind(*actor.user.as_uuid()).execute(owner).await.unwrap();
    id
}
fn create(site: Uuid, name: &str) -> Value {
    json!({"op":"CREATE_ORG_UNIT","kind":"DEPARTMENT","parentId":site,"name":name})
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn projected_siblings_and_rename_link_only_their_own_change_sets(owner: PgPool) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "asof-attribution").await;
    let today: Date = sqlx::query_scalar("SELECT (now() AT TIME ZONE 'Asia/Seoul')::date")
        .fetch_one(&owner)
        .await
        .unwrap();
    let (_, [(wp, site), _]) = two_workplaces(&store, &actor).await;
    let setup = store
        .apply_org_setup_batch(
            &cmd(&actor),
            vec![under_workplace("old", "Existing", wp)],
            port(),
        )
        .await
        .unwrap();
    let due = today + Duration::days(10);
    request(&owner, &actor, site, 1, due, create(site, "First")).await;
    request(&owner, &actor, site, 2, due, create(site, "Second")).await;
    request(
        &owner,
        &actor,
        setup.units[0].org_unit_id,
        3,
        due,
        json!({"op":"RENAME_ORG_UNIT","orgUnitId":setup.units[0].org_unit_id,"name":"Renamed"}),
    )
    .await;
    let diff = store
        .structure_diff(&actor, today, due, ReadOptions::default())
        .await
        .unwrap();
    for (name, code) in [
        ("First", "OC-2026-0001"),
        ("Second", "OC-2026-0002"),
        ("Renamed", "OC-2026-0003"),
    ] {
        let mark = diff.marks.iter().find(|m| m.name == name).unwrap();
        assert_eq!(
            mark.changes
                .iter()
                .map(|c| c.code.as_str())
                .collect::<Vec<_>>(),
            [code],
            "{name}"
        );
    }
    assert_eq!(diff.changes.len(), 3);
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn applied_creations_link_canonical_receipts_and_prior_known_views_keep_projected_ids(
    owner: PgPool,
) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "asof-applied-attribution").await;
    let today: Date = sqlx::query_scalar("SELECT (now() AT TIME ZONE 'Asia/Seoul')::date")
        .fetch_one(&owner)
        .await
        .unwrap();
    let (_, [(_, site), _]) = two_workplaces(&store, &actor).await;
    let due = today + Duration::days(10);
    let requests = [
        request(&owner, &actor, site, 1, due, create(site, "First")).await,
        request(&owner, &actor, site, 2, due, create(site, "Second")).await,
    ];
    let cutoff: OffsetDateTime = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&owner)
        .await
        .unwrap();
    let mut units = Vec::new();
    for (n, name) in ["First", "Second"].into_iter().enumerate() {
        let mut tx = owner.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org',$1,true)")
            .bind(actor.org.to_string())
            .execute(tx.as_mut())
            .await
            .unwrap();
        // The native org-change writer's stable operation command identifies its canonical receipt.
        let id = port().write(&mut tx,actor.org,actor.user,projected_unit_id(requests[n],0),None,
            json!({"name":name,"kind":"department","parent_id":site,"status":"active","effective_from":due.to_string()})).await.unwrap();
        sqlx::query("UPDATE org_change_requests SET status='APPLIED' WHERE id=$1")
            .bind(requests[n])
            .execute(tx.as_mut())
            .await
            .unwrap();
        tx.commit().await.unwrap();
        units.push(id);
    }
    for known_at in [None, Some(cutoff)] {
        let diff = store
            .structure_diff(
                &actor,
                today,
                due,
                ReadOptions {
                    as_of: None,
                    known_at,
                },
            )
            .await
            .unwrap();
        for (n, name) in ["First", "Second"].into_iter().enumerate() {
            let mark = diff.marks.iter().find(|m| m.name == name).unwrap();
            assert_eq!(
                mark.id,
                if known_at.is_some() {
                    projected_unit_id(requests[n], 0)
                } else {
                    units[n]
                }
            );
            assert_eq!(
                mark.changes.iter().map(|c| c.change_id).collect::<Vec<_>>(),
                [requests[n]]
            );
        }
    }
}
