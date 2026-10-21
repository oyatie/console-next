#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The 0263 data step (decisions #18, MR-20), replayed over seeded legacy
//! data (sqlx::test migrates an empty database): a 지점 bound by the old
//! flow to a name-only anchor unit, now backing a 사업장, gets kind 지점 and
//! its binding re-pointed at the 사업장's own unit; a second run changes
//! nothing. The anchor has no kind, so it is never drawn in the tree.

mod common;

use common::*;
use sqlx::PgPool;
use uuid::Uuid;

const ORG_M: Uuid = Uuid::from_u128(0xB000_0000_0000_0000_0000_0000_0000_0E19);
const MIGRATION: &str = include_str!("../../../platform/db/migrations/0298_workplace_kinds.sql");

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_legacy_branch_maps_onto_its_workplace(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG_M, "M").await;
    let entity = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", "000211-0006241"))
        .await
        .unwrap()
        .record
        .id;
    let reg = store
        .create_registration(&cmd(&actor), entity, certificate("000-81-00009"))
        .await
        .unwrap()
        .record
        .id;
    let wp = store
        .create_workplace(
            &cmd(&actor),
            entity,
            workplace_from(reg, "부산 지점"),
            port(),
        )
        .await
        .unwrap()
        .record;
    let (branch, site) = (wp.default_branch_id.unwrap(), wp.org_unit_id.unwrap());
    // The old 지점 flow bound the branch to a name-only anchor unit.
    let anchor = Uuid::new_v4();
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(ORG_M.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO org_units (org_id, id) VALUES ($1, $2)")
        .bind(ORG_M)
        .bind(anchor)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO org_unit_revisions (org_id, org_unit_id, version, command_id, actor_id, payload_digest, attributes, receipt) \
         VALUES ($1, $2, 1, gen_random_uuid(), $3, decode(repeat('00', 32), 'hex'), '{\"name\": \"부산 지점\"}', '{}')",
    )
    .bind(ORG_M).bind(anchor).bind(*actor.user.as_uuid()).execute(&mut *tx).await.unwrap();
    sqlx::query(
        "INSERT INTO org_unit_source_bindings (org_id, source_kind, source_id, org_unit_id, actor_id, payload_digest) \
         VALUES ($1, 'branch', $2, $3, $4, decode(repeat('00', 32), 'hex'))",
    )
    .bind(ORG_M).bind(branch.to_string()).bind(anchor).bind(*actor.user.as_uuid()).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    // The anchor has no kind: it is never drawn as a tree node.
    assert!(
        store
            .org_structure(&actor)
            .await
            .unwrap()
            .unplaced
            .is_empty()
    );

    let start = MIGRATION.find("DO $$").unwrap();
    let block = &MIGRATION[start..];
    for _ in 0..2 {
        sqlx::raw_sql(block).execute(&owner).await.unwrap();
        let (kind_code, bound): (Option<String>, Uuid) = sqlx::query_as(
            "SELECT w.kind_code, b.org_unit_id FROM workplaces w JOIN org_unit_source_bindings b \
               ON b.source_kind = 'branch' AND b.source_id = w.default_branch_id::text WHERE w.id = $1",
        )
        .bind(wp.id)
        .fetch_one(&owner)
        .await
        .unwrap();
        assert_eq!(
            (kind_code.as_deref(), bound),
            (Some("BRANCH"), site),
            "idempotent"
        );
    }
    let bindings: i64 =
        sqlx::query_scalar("SELECT count(*) FROM org_unit_source_bindings WHERE org_id = $1")
            .bind(ORG_M)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(bindings, 1);
}
