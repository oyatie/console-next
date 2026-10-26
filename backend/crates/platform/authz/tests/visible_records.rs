// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "visible_set/world.rs"]
mod world;

use console_platform_authz::Feature;
use console_platform_authz::access::{NodeKind, NodeRef};
use console_platform_authz::cedar_pbac::residual::SqlValue;
use console_platform_authz::cedar_pbac::visible::load_facts;
use console_platform_test_support::runtime_role_pool;
use sqlx::PgPool;
use uuid::Uuid;
use world::{KINDS, World, arm};

async fn seed_records(pool: &PgPool, w: &World) -> Vec<Uuid> {
    let mut ids = Vec::new();
    // Multiple records share each node: visible IDs must be records, not nodes.
    for unit in w
        .nodes
        .iter()
        .filter(|n| n.kind == NodeKind::Department)
        .map(|n| Some(n.id))
        .chain([None])
    {
        for _ in 0..2 {
            let id = Uuid::new_v4();
            sqlx::query("INSERT INTO employees (id,org_id,company,name,source_filename,source_sheet,source_row,source_key,org_unit_id) VALUES ($1,$2,'parity','record','parity.xlsx','records',1,$3,$4)")
                .bind(id).bind(w.org.as_uuid()).bind(id.to_string()).bind(unit)
                .execute(pool).await.unwrap();
            ids.push(id);
        }
    }
    ids
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn employee_list_and_count_equal_point_decision_for_every_seeded_record(pool: PgPool) {
    let w = World::seed(&pool, &[vec![2, 1], vec![1]]).await;
    let foreign = World::seed(&pool, &[vec![1]]).await;
    let records = seed_records(&pool, &w).await;
    let foreign_records = seed_records(&pool, &foreign).await;
    let rt = runtime_role_pool(&pool).await;
    for (scope, ops) in KINDS
        .into_iter()
        .map(|kind| (Some(kind), false))
        .chain([(None, false), (None, true)])
    {
        let actor = w.holder(&pool, scope, ops, 0).await;
        let mut tx = rt.begin().await.unwrap();
        arm(&mut tx, w.org).await;
        let facts = load_facts(&mut tx, w.org, actor).await.unwrap();
        // No explicit tenant predicate: exercise the runtime RLS floor too.
        let all: Vec<(Uuid, Option<Uuid>)> =
            sqlx::query_as("SELECT id,org_unit_id FROM employees ORDER BY id")
                .fetch_all(tx.as_mut())
                .await
                .unwrap();
        assert_eq!(all.len(), records.len());
        for action in [
            Feature::EmployeeDirectoryRead,
            Feature::EmployeeDirectoryManage,
        ] {
            let filter = facts
                .visible(action.as_str(), NodeKind::Department, "e.org_unit_id", 1)
                .unwrap();
            let from = format!("FROM employees e WHERE {}", filter.where_sql);
            let list_sql = format!("SELECT e.id {from}");
            let mut list = sqlx::query_scalar::<_, Uuid>(sqlx::AssertSqlSafe(list_sql.as_str()));
            let count_sql = format!("SELECT count(*) {from}");
            let mut count = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(count_sql.as_str()));
            for bind in &filter.binds {
                let SqlValue::TextArray(values) = bind else {
                    panic!("scope-node filter must bind a text array")
                };
                list = list.bind(values);
                count = count.bind(values);
            }
            let visible = list.fetch_all(tx.as_mut()).await.unwrap();
            let count = count.fetch_one(tx.as_mut()).await.unwrap();
            assert_eq!(count, visible.len() as i64);
            assert!(foreign_records.iter().all(|id| !visible.contains(id)));
            for (id, unit) in &all {
                let allowed = unit.is_some_and(|id| {
                    facts
                        .authorize(
                            action.as_str(),
                            NodeRef {
                                kind: NodeKind::Department,
                                id,
                            },
                        )
                        .unwrap()
                });
                assert_eq!(
                    visible.contains(id),
                    allowed,
                    "scope={scope:?}, ops={ops}, action={action:?}, employee={id}"
                );
            }
            if ops || (action == Feature::EmployeeDirectoryRead && scope.is_some()) {
                assert!(!visible.is_empty(), "exercise an actual record permit");
            } else {
                assert!(visible.is_empty(), "exercise deny by omission");
            }
        }
        tx.rollback().await.unwrap();
    }
}
