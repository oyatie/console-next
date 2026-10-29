// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "visible_set/world.rs"]
mod world;

use console_kernel_core::OrgId;
use console_platform_authz::Feature;
use console_platform_authz::access::{NodeKind, NodeRef};
use console_platform_authz::cedar_pbac::residual::{ResidualFilter, SqlValue};
use console_platform_authz::cedar_pbac::visible::load_facts;
use console_platform_test_support::runtime_role_pool;
use proptest::prelude::*;
use proptest::strategy::ValueTree;
use proptest::test_runner::{Config, RngSeed, TestRunner};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;
use world::{KINDS, World, arm};

async fn members(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    kind: NodeKind,
    filter: ResidualFilter,
) -> Vec<Uuid> {
    let (table, org_column) = match kind {
        NodeKind::Tenant => ("organizations", "id"),
        NodeKind::LegalEntity => ("legal_entities", "org_id"),
        NodeKind::Workplace => ("workplaces", "org_id"),
        NodeKind::Department => ("org_units", "org_id"),
    };
    let from = format!(
        "FROM {table} n WHERE n.{org_column} = $1 AND {}",
        filter.where_sql
    );
    let list = format!("SELECT n.id {from} ORDER BY n.id");
    let mut query =
        sqlx::query_scalar::<_, Uuid>(sqlx::AssertSqlSafe(list.as_str())).bind(org.as_uuid());
    for bind in &filter.binds {
        let SqlValue::TextArray(values) = bind else {
            panic!("node residual must bind a text array")
        };
        query = query.bind(values);
    }
    let ids = query.fetch_all(tx.as_mut()).await.unwrap();
    let count = format!("SELECT count(*) {from}");
    let mut query =
        sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(count.as_str())).bind(org.as_uuid());
    for bind in &filter.binds {
        let SqlValue::TextArray(values) = bind else {
            panic!("node residual must bind a text array")
        };
        query = query.bind(values);
    }
    assert_eq!(
        query.fetch_one(tx.as_mut()).await.unwrap(),
        ids.len() as i64
    );
    ids
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn authorize_equals_visible_membership_over_generated_tree_and_scope_kinds(pool: PgPool) {
    let rt = runtime_role_pool(&pool).await;
    let mut runner = TestRunner::new(Config {
        rng_seed: RngSeed::Fixed(20261026),
        ..Config::default()
    });
    let shape = prop::collection::vec(prop::collection::vec(1usize..4, 1..3), 1..4);
    for generation in 0..8 {
        let generated = shape.new_tree(&mut runner).unwrap().current();
        let w = World::seed(&pool, &generated).await;
        for (scope, ops) in KINDS
            .into_iter()
            .map(|k| (Some(k), false))
            .chain([(None, false), (None, true)])
        {
            let actor = w.holder(&pool, scope, ops, generation).await;
            let mut tx = rt.begin().await.unwrap();
            arm(&mut tx, w.org).await;
            let facts = load_facts(&mut tx, w.org, actor).await.unwrap();
            for action in [
                Feature::EmployeeDirectoryRead,
                Feature::EmployeeDirectoryManage,
            ] {
                for kind in KINDS {
                    let filter = facts.visible(action.as_str(), kind, "n.id", 2).unwrap();
                    let visible = members(&mut tx, w.org, kind, filter).await;
                    for node in w.nodes.iter().filter(|n| n.kind == kind) {
                        assert_eq!(
                            facts.authorize(action.as_str(), *node).unwrap(),
                            visible.contains(&node.id),
                            "actor={actor}, scope={scope:?}, action={action:?}, node={node:?}"
                        );
                        if ops {
                            assert!(visible.contains(&node.id), "ops policy must be exercised");
                        }
                    }
                    if scope == Some(kind) && action == Feature::EmployeeDirectoryRead {
                        let candidates: Vec<_> =
                            w.nodes.iter().filter(|n| n.kind == kind).collect();
                        assert!(visible.contains(&candidates[generation % candidates.len()].id));
                    }
                    if !ops && (scope.is_none() || action == Feature::EmployeeDirectoryManage) {
                        assert!(visible.is_empty(), "deny by omission");
                    }
                }
            }
            tx.rollback().await.unwrap();
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn loader_and_residual_refuse_untrusted_missing_foreign_and_stale_facts(pool: PgPool) {
    let w = World::seed(&pool, &[vec![2], vec![1]]).await;
    let foreign = World::seed(&pool, &[vec![1]]).await;
    let actor = w.holder(&pool, Some(NodeKind::Tenant), false, 0).await;
    let orphan = Uuid::new_v4();
    sqlx::query("INSERT INTO org_units (org_id,id) VALUES ($1,$2)")
        .bind(w.org.as_uuid())
        .bind(orphan)
        .execute(&pool)
        .await
        .unwrap();
    let rt = runtime_role_pool(&pool).await;
    let action = Feature::EmployeeDirectoryRead.as_str();
    let mut owner_tx = pool.begin().await.unwrap();
    arm(&mut owner_tx, w.org).await;
    assert!(load_facts(&mut owner_tx, w.org, actor).await.is_err());
    owner_tx.rollback().await.unwrap();
    let mut tx = rt.begin().await.unwrap();
    assert!(load_facts(&mut tx, w.org, actor).await.is_err());
    arm(&mut tx, w.org).await;
    assert!(load_facts(&mut tx, foreign.org, actor).await.is_err());
    assert!(load_facts(&mut tx, w.org, Uuid::new_v4()).await.is_err());
    let facts = load_facts(&mut tx, w.org, actor).await.unwrap();
    for node in &foreign.nodes {
        assert!(!facts.authorize(action, *node).unwrap());
    }
    assert!(
        !facts
            .authorize(
                action,
                NodeRef {
                    kind: NodeKind::Department,
                    id: orphan
                }
            )
            .unwrap()
    );
    let filter = facts
        .visible(action, NodeKind::Department, "n.id", 2)
        .unwrap();
    let ids = members(&mut tx, w.org, NodeKind::Department, filter).await;
    assert_eq!(
        ids.len(),
        3,
        "one incomplete path must not hide healthy nodes"
    );
    assert!(!ids.contains(&orphan));
    assert!(
        !facts
            .authorize(
                action,
                NodeRef {
                    kind: NodeKind::Department,
                    id: Uuid::new_v4()
                }
            )
            .unwrap()
    );
    assert!(facts.authorize("unknown_action", w.nodes[0]).is_err());
    assert!(
        facts
            .visible("unknown_action", NodeKind::Department, "n.id", 2)
            .is_err()
    );
    for column in ["n.id; DROP TABLE users", "n.id::text", ""] {
        assert!(
            facts
                .visible(action, NodeKind::Department, column, 2)
                .unwrap()
                .is_deny_all()
        );
    }
    assert!(
        facts
            .visible(action, NodeKind::Department, "n.id", 0)
            .unwrap()
            .is_deny_all()
    );
    // Even an unconstrained residual cannot escape the runtime RLS tenant floor.
    let all: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM legal_entities")
        .fetch_all(tx.as_mut())
        .await
        .unwrap();
    assert_eq!(all.len(), 2);
    assert!(!all.contains(&foreign.nodes[1].id));
    tx.rollback().await.unwrap();
    sqlx::query("UPDATE access_grants SET status='REVOKED', revoked_by=$2, revoked_at=now() WHERE org_id=$1 AND account_id=$2")
        .bind(w.org.as_uuid()).bind(actor).execute(&pool).await.unwrap();
    let mut tx = rt.begin().await.unwrap();
    arm(&mut tx, w.org).await;
    let facts = load_facts(&mut tx, w.org, actor).await.unwrap();
    assert!(
        facts
            .visible(action, NodeKind::Department, "n.id", 2)
            .unwrap()
            .is_deny_all()
    );
    tx.rollback().await.unwrap();
    sqlx::query("UPDATE users SET is_active=false WHERE org_id=$1 AND id=$2")
        .bind(w.org.as_uuid())
        .bind(actor)
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = rt.begin().await.unwrap();
    arm(&mut tx, w.org).await;
    assert!(load_facts(&mut tx, w.org, actor).await.is_err());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn loader_refuses_each_unprotected_fact_table(pool: PgPool) {
    let w = World::seed(&pool, &[vec![1]]).await;
    let actor = w.holder(&pool, Some(NodeKind::Tenant), false, 0).await;
    for statement in [
        "ALTER TABLE access_grants DISABLE ROW LEVEL SECURITY",
        "ALTER TABLE users DISABLE ROW LEVEL SECURITY",
        "ALTER TABLE legal_entities DISABLE ROW LEVEL SECURITY",
        "ALTER TABLE workplaces DISABLE ROW LEVEL SECURITY",
        "ALTER TABLE org_units DISABLE ROW LEVEL SECURITY",
        "ALTER TABLE employees DISABLE ROW LEVEL SECURITY",
    ] {
        let mut tx = pool.begin().await.unwrap();
        sqlx::query(sqlx::AssertSqlSafe(statement))
            .execute(tx.as_mut())
            .await
            .unwrap();
        sqlx::query("SET LOCAL ROLE console_rt")
            .execute(tx.as_mut())
            .await
            .unwrap();
        arm(&mut tx, w.org).await;
        assert!(
            load_facts(&mut tx, w.org, actor).await.is_err(),
            "{statement}"
        );
        tx.rollback().await.unwrap();
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn voided_entities_workplaces_and_dissolved_departments_never_enter_visible_sets(
    pool: PgPool,
) {
    let w = World::seed(&pool, &[vec![2], vec![2], vec![2]]).await;
    let actor = w.holder(&pool, Some(NodeKind::Tenant), false, 0).await;
    let of_kind = |kind| {
        w.nodes
            .iter()
            .filter(|n| n.kind == kind)
            .copied()
            .collect::<Vec<_>>()
    };
    let entities = of_kind(NodeKind::LegalEntity);
    let workplaces = of_kind(NodeKind::Workplace);
    let departments = of_kind(NodeKind::Department);
    sqlx::query(
        "UPDATE legal_entities SET voided_at=now(), void_reason_code='MISTAKE' WHERE id=$1",
    )
    .bind(entities[0].id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE workplaces SET voided_at=now(), void_reason_code='MISTAKE' WHERE id=$1")
        .bind(workplaces[1].id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO org_unit_revisions (org_id,org_unit_id,version,command_id,actor_id,payload_digest,attributes,receipt) SELECT org_id,org_unit_id,2,gen_random_uuid(),actor_id,payload_digest,jsonb_set(attributes,'{status}','\"dissolved\"'),receipt FROM org_unit_revisions WHERE org_unit_id=$1")
        .bind(departments[5].id).execute(&pool).await.unwrap();
    let rt = runtime_role_pool(&pool).await;
    let mut tx = rt.begin().await.unwrap();
    arm(&mut tx, w.org).await;
    let facts = load_facts(&mut tx, w.org, actor).await.unwrap();
    let action = Feature::EmployeeDirectoryRead.as_str();
    for (kind, expected) in [
        (NodeKind::LegalEntity, vec![entities[1].id, entities[2].id]),
        (NodeKind::Workplace, vec![workplaces[2].id]),
        (NodeKind::Department, vec![departments[4].id]),
    ] {
        let ids = members(
            &mut tx,
            w.org,
            kind,
            facts.visible(action, kind, "n.id", 2).unwrap(),
        )
        .await;
        for node in of_kind(kind) {
            let allowed = expected.contains(&node.id);
            assert_eq!(facts.authorize(action, node).unwrap(), allowed, "{node:?}");
            assert_eq!(ids.contains(&node.id), allowed, "{node:?}");
        }
    }
}
