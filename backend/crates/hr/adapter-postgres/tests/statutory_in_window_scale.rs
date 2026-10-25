// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]
mod support;
#[path = "support/trail_queries.rs"]
mod trail_queries;
#[path = "statutory/world.rs"]
mod world;
use console_hr_adapter_postgres::statutory::FilingQuery;
use serde_json::Value;
use sqlx::PgPool;
use tracing::instrument::WithSubscriber;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn in_window_hydration_never_exceeds_the_keyset_page(pool: PgPool) {
    let w = world::world(&pool).await;
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE employees SET birth_date=NULL WHERE org_id=$1")
        .bind(w.tenant.org)
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO employees (org_id,company,name,employee_number,employment_status,source_filename,source_sheet,source_row,source_key,hire_date,hire_on) SELECT $1,'Test','Window worker '||n,'WIN-'||n,'ACTIVE','window.xlsx','Sheet',n,'in-window-'||n,current_date::text,current_date FROM generate_series(1,1999) n")
        .bind(w.tenant.org).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO employment_assignments (org_id,employee_id,legal_entity_id,workplace_id,valid_from,cause,command_id) SELECT $1,id,$2,$3,current_date,'MIGRATION',gen_random_uuid() FROM employees WHERE org_id=$1 AND source_key LIKE 'in-window-%'")
        .bind(w.tenant.org).bind(w.entity).bind(w.site).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO employee_lifecycle_events (org_id,employee_id,event_type,to_status,effective_date,comment,created_by,state) SELECT $1,id,'ONBOARD','ACTIVE',current_date::text,'in-window hire',$2,'APPLIED' FROM employees WHERE org_id=$1 AND source_key LIKE 'in-window-%'")
        .bind(w.tenant.org).bind(w.user.as_uuid()).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    let queries = trail_queries::Queries::default();
    let (page, exact) = w
        .tenant
        .hr
        .insurance_inbox_page(
            support::principal(w.tenant.org, w.user),
            FilingQuery {
                state: Some("PENDING".into()),
                limit: Some(50),
                ..Default::default()
            },
            world::register_rules(&pool).await,
        )
        .with_subscriber(queries.clone())
        .await
        .unwrap();
    assert_eq!(page.items.len(), 50);
    assert!(!exact);
    assert!(page.next.is_some());
    assert_eq!(queries.scans(), 1);
    let records = queries.statements();
    let register_rows = records
        .iter()
        .find(|s| s.contains("FROM lifecycle_filing_rules") && !s.contains("filtered AS"))
        .unwrap();
    let fetched: i64 = register_rows
        .split("rows_returned=")
        .nth(1)
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap()
        .parse()
        .unwrap();
    let all_rules: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM lifecycle_filing_rules WHERE filing_rule IS NOT NULL",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        fetched < all_rules,
        "decode only the rule versions that overlap the source event dates: {fetched}/{all_rules}"
    );
    let logged = records.iter().find(|s| s.contains("filtered AS")).unwrap();
    let sql: String = serde_json::from_str(
        logged
            .split("db.statement=")
            .nth(1)
            .unwrap()
            .split(" rows_affected=")
            .next()
            .unwrap(),
    )
    .unwrap();
    let explain = format!("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {sql}");
    let mut conn = pool.acquire().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,false)")
        .bind(w.tenant.org.to_string())
        .execute(&mut *conn)
        .await
        .unwrap();
    sqlx::query("SET jit=off")
        .execute(&mut *conn)
        .await
        .unwrap();
    // Only the captured, application-built SQL is explained; fixture values remain bound.
    let mut q = sqlx::query_scalar::<_, Value>(sqlx::AssertSqlSafe(explain)).bind(w.tenant.org);
    // The in-window fixture is after every cutoff; null bounds preserve exactly that candidate set.
    if sql.contains("earliest_event_on") {
        let bounds:Value=sqlx::query_scalar("SELECT jsonb_agg(jsonb_build_object('code',code,'effective_from',effective_from,'earliest_event_on',NULL)) FROM lifecycle_filing_rules WHERE filing_rule IS NOT NULL")
            .fetch_one(&mut *conn).await.unwrap();
        q = q.bind(bounds);
    }
    let plan: Value = q
        .bind(vec!["DISPATCHED_IN", "OUTSOURCED_ON_SITE", "FREELANCE"])
        .bind(51_i64)
        .bind(None::<time::OffsetDateTime>)
        .fetch_one(&mut *conn)
        .await
        .unwrap();
    eprintln!(
        "EXPLAIN (ANALYZE, BUFFERS): {}",
        serde_json::to_string_pretty(&plan).unwrap()
    );
    fn check(node: &Value, seen: &mut usize) {
        if matches!(
            node["Relation Name"].as_str(),
            Some(
                "lifecycle_case_items"
                    | "workplace_revisions"
                    | "insurance_filing_records"
                    | "employment_assignments"
                    | "filing_obligations"
            )
        ) {
            *seen += 1;
            assert!(
                node["Actual Loops"].as_u64().unwrap() <= 51,
                "hydration ran before LIMIT: {node}"
            );
        }
        if let Some(children) = node["Plans"].as_array() {
            for child in children {
                check(child, seen);
            }
        }
    }
    let mut seen = 0;
    check(&plan[0]["Plan"], &mut seen);
    assert!(
        seen >= 2,
        "both case and workplace hydration must be measured"
    );
}
