// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "visible_set/world.rs"]
mod world;
use console_platform_authz::cedar_pbac::{residual::SqlValue, visible::load_facts};
use console_platform_authz::{Feature, access::NodeKind};
use console_platform_test_support::runtime_role_pool;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn privacy_intake_reuses_hr_edit_scope_for_point_list_and_count(pool: PgPool) {
    let w = world::World::seed(&pool, &[vec![1, 1]]).await;
    let foreign = world::World::seed(&pool, &[vec![1]]).await;
    let actor = w.holder(&pool, Some(NodeKind::Workplace), false, 0).await;
    sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) SELECT org_id,role_id,2,name_ko,status,change_mode,created_by FROM access_role_versions WHERE org_id=$1 AND version=1 AND role_id IN (SELECT role_id FROM access_grants WHERE org_id=$1 AND account_id=$2)")
        .bind(w.org.as_uuid()).bind(actor).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) SELECT org_id,role_id,2,'hr_basic',ARRAY['edit'] FROM access_grants WHERE org_id=$1 AND account_id=$2")
        .bind(w.org.as_uuid()).bind(actor).execute(&pool).await.unwrap();
    sqlx::query("UPDATE access_roles SET version=2 WHERE org_id=$1 AND id IN (SELECT role_id FROM access_grants WHERE org_id=$1 AND account_id=$2)")
        .bind(w.org.as_uuid()).bind(actor).execute(&pool).await.unwrap();
    let runtime = runtime_role_pool(&pool).await;
    let mut tx = runtime.begin().await.unwrap();
    world::arm(&mut tx, w.org).await;
    let facts = load_facts(&mut tx, w.org, actor).await.unwrap();
    let action = Feature::PrivacyRequestDecide.as_str();
    for kind in world::KINDS {
        for node in w.nodes.iter().filter(|node| node.kind == kind) {
            assert_eq!(
                facts.authorize(action, *node).unwrap(),
                facts
                    .authorize(Feature::EmployeeDirectoryManage.as_str(), *node)
                    .unwrap()
            );
        }
    }
    for node in &foreign.nodes {
        assert!(!facts.authorize(action, *node).unwrap());
    }
    let filter = facts
        .visible(action, NodeKind::Workplace, "n.id", 2)
        .unwrap();
    let SqlValue::TextArray(ids) = &filter.binds[0] else {
        panic!("UUID set expected")
    };
    let list = format!(
        "SELECT n.id FROM workplaces n WHERE n.org_id=$1 AND {}",
        filter.where_sql
    );
    let visible: Vec<Uuid> = sqlx::query_scalar(sqlx::AssertSqlSafe(list.as_str()))
        .bind(w.org.as_uuid())
        .bind(ids)
        .fetch_all(tx.as_mut())
        .await
        .unwrap();
    assert_eq!(visible.len(), 1, "the other workplace must be absent");
    let count = format!(
        "SELECT count(*) FROM workplaces n WHERE n.org_id=$1 AND {}",
        filter.where_sql
    );
    let total: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(count.as_str()))
        .bind(w.org.as_uuid())
        .bind(ids)
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
    assert_eq!(total, 1);
    let wrong_tenant = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(count.as_str()))
        .bind(foreign.org.as_uuid())
        .bind(ids)
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
    assert_eq!(wrong_tenant, 0);
}
