// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod support;
use serde_json::Value;
use sqlx::PgPool;
use support::world;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn exact_filters_use_tenant_keyset_indexes(pool: PgPool) {
    let w = world(pool).await;
    sqlx::query("INSERT INTO audit_events(org_id,actor,action,target_type,target_id,trace_id,span_id,occurred_at,created_at,after_snap) SELECT $1,CASE WHEN n=1 THEN $3 ELSE $2 END,CASE WHEN n=1 THEN 'employee.rrn_reveal' ELSE 'employee.read' END,CASE WHEN n=1 THEN 'user' ELSE 'employee' END,'test',repeat('a',32),repeat('b',16),'2026-09-10T02:00:00Z','2026-09-10T02:00:00Z','{\"self_read\":false}'::jsonb FROM generate_series(1,5000) n")
        .bind(w.org).bind(w.hr.as_uuid()).bind(w.hr2.as_uuid()).execute(&w.owner).await.unwrap();
    sqlx::raw_sql("ANALYZE audit_events")
        .execute(&w.owner)
        .await
        .unwrap();
    let mut tx = w.rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(w.org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    for (actor, action, target, index, column) in [
        (
            Some(w.hr2.to_string()),
            None,
            None,
            "idx_access_log_actor_page",
            "actor",
        ),
        (
            None,
            Some("employee.rrn_reveal"),
            None,
            "idx_access_log_action_page",
            "action",
        ),
        (
            None,
            None,
            Some("user"),
            "idx_access_log_target_type_page",
            "target_type",
        ),
    ] {
        let mut sql = sqlx::QueryBuilder::new("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ");
        sql.push(
            include_str!("../../access/src/log_review/search.sql").replace(
                "{outcome}",
                include_str!("../../access/src/log_review/outcome.sql"),
            ),
        );
        let plan: Value = sql
            .build_query_scalar()
            .bind(w.org)
            .bind(time::macros::datetime!(2026-08-31 15:00 UTC))
            .bind(time::macros::datetime!(2026-09-30 15:00 UTC))
            .bind(time::macros::datetime!(2026-11-01 0:00 UTC))
            .bind(None::<String>)
            .bind(Vec::<uuid::Uuid>::new())
            .bind("Asia/Seoul")
            .bind(actor)
            .bind(action)
            .bind(target)
            .bind(Some("2026-09-10"))
            .bind(Some("2026-09-10"))
            .fetch_one(tx.as_mut())
            .await
            .unwrap();
        let rendered = serde_json::to_string_pretty(&plan).unwrap();
        let definition: String = sqlx::query_scalar(
            "SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname=$1",
        )
        .bind(index)
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
        assert!(
            definition.contains(&format!("(org_id, {column}, created_at, id)")),
            "{definition}"
        );
        let conditions = rendered
            .lines()
            .filter(|line| line.contains("Index Cond"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(conditions.contains(column), "{rendered}");
        assert!(!rendered.contains("Seq Scan"), "{rendered}");
        assert!(rendered.contains("Index Cond"), "{rendered}");
        eprintln!("{rendered}");
    }
}
