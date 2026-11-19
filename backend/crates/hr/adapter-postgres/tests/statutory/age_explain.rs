// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{QUERY_CAPTURE, age_scale, support, trail_queries, world};
use console_hr_adapter_postgres::statutory::FilingQuery;
use serde_json::Value;
use sqlx::PgPool;
use tracing::instrument::WithSubscriber;

pub(super) async fn explain_age(pool: &PgPool, org: uuid::Uuid, captured: &[String]) {
    let logged = captured
        .iter()
        .find(|s| s.contains("WHERE inbox_id = ANY("))
        .unwrap();
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
    let mut conn = pool.acquire().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,false)")
        .bind(org.to_string())
        .execute(&mut *conn)
        .await
        .unwrap();
    sqlx::query("SET jit=off")
        .execute(&mut *conn)
        .await
        .unwrap();
    let bounds:Value=sqlx::query_scalar("SELECT jsonb_agg(jsonb_build_object('code',code,'effective_from',effective_from,'earliest_event_on',NULL)) FROM lifecycle_filing_rules WHERE filing_rule IS NOT NULL").fetch_one(&mut *conn).await.unwrap();
    let explain = format!("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {sql}");
    let ids = age_scale::inbox_ids(pool, org).await;
    let mut q = sqlx::query_scalar::<_, Value>(sqlx::AssertSqlSafe(explain))
        .bind(org)
        .bind(&ids)
        .bind(bounds)
        .bind(vec!["DISPATCHED_IN", "OUTSOURCED_ON_SITE", "FREELANCE"])
        .bind("AGE60");
    if sql.contains("age_rules AS") {
        let rules: Value = sqlx::query_scalar(
            "SELECT jsonb_agg(filing_rule) FROM statutory_rules WHERE filing_rule IS NOT NULL",
        )
        .fetch_one(&mut *conn)
        .await
        .unwrap();
        q = q.bind(rules).bind(None::<time::OffsetDateTime>).bind(&ids);
    }
    let plan: Value = q
        .bind(None::<time::OffsetDateTime>)
        .fetch_one(&mut *conn)
        .await
        .unwrap();
    fn check(node: &Value, seen: &mut std::collections::BTreeSet<String>, max: &mut u64) {
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
            seen.insert(node["Relation Name"].as_str().unwrap().to_owned());
            *max = (*max).max(node["Actual Loops"].as_u64().unwrap());
        }
        if let Some(children) = node["Plans"].as_array() {
            for child in children {
                check(child, seen, max);
            }
        }
    }
    let (mut seen, mut max) = (std::collections::BTreeSet::new(), 0);
    check(&plan[0]["Plan"], &mut seen, &mut max);
    eprintln!(
        "AGE60 EXPLAIN: relations={}, maximum hydration loops={max}, execution_ms={}",
        seen.len(),
        plan[0]["Execution Time"]
    );
    assert_eq!(seen.len(), 5, "all hydration relations must be measured");
    assert!(max <= 51, "hydration ran before LIMIT: {max}");
}

fn check_cohort(node: &Value, limit: usize, observed: &mut std::collections::BTreeSet<String>) {
    if let Some(name @ ("CTE sources" | "CTE age_facts" | "CTE age_assignments")) =
        node["Subplan Name"].as_str()
    {
        let rows = node["Actual Rows"].as_u64().unwrap() * node["Actual Loops"].as_u64().unwrap();
        assert!(
            (1..=limit as u64).contains(&rows),
            "{name} materialized {rows} rows for {limit} matched people"
        );
        observed.insert(name.to_owned());
    }
    if let Some(children) = node["Plans"].as_array() {
        for child in children {
            check_cohort(child, limit, observed);
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn age60_companion_reads_only_probed_people(pool: PgPool) {
    let _capture = QUERY_CAPTURE.lock().await;
    let w = world::world(&pool).await;
    age_scale::seed(&pool, w.tenant.org, w.user, w.entity, w.site, 80, 3).await;
    sqlx::query("INSERT INTO insurance_filing_records (org_id,event_id,filing_kind,insurer,version,action,actor,idempotency_key,request_hash,applicability_facts) SELECT l.org_id,l.id,'AGE60','NPS',1,'ASSESS',$2,l.id::text,repeat('a',64),jsonb_build_object('birth_date',e.birth_date) FROM employee_lifecycle_events l JOIN employees e ON e.id=l.employee_id WHERE l.org_id=$1")
        .bind(w.tenant.org).bind(w.user.as_uuid()).execute(&pool).await.unwrap();
    let trace = trail_queries::Queries::default();
    let rules = world::register_rules(&pool).await;
    let (page, _) = w
        .tenant
        .hr
        .insurance_inbox_page(
            support::principal(w.tenant.org, w.user),
            FilingQuery {
                kind: Some("AGE60".into()),
                ..Default::default()
            },
            rules.clone(),
            None,
        )
        .with_subscriber(trace.clone())
        .await
        .unwrap();
    assert_eq!(page.total, 3);
    let people: Vec<_> = page.items.iter().map(|t| t.employee_id).collect();
    let ids: Vec<_> = page.items.iter().map(|t| t.inbox_id()).collect();
    let bounds: serde_json::Value = sqlx::query_scalar("SELECT jsonb_agg(jsonb_build_object('code',code,'effective_from',effective_from,'earliest_event_on',NULL)) FROM lifecycle_filing_rules WHERE filing_rule IS NOT NULL")
        .fetch_one(&pool).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL jit=off")
        .execute(tx.as_mut())
        .await
        .unwrap();
    let mut plans = 0;
    for logged in trace
        .statements()
        .iter()
        .filter(|s| s.contains("age_placements AS"))
    {
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
        let selected = sql.contains("WHERE inbox_id = ANY(");
        let explain = format!("EXPLAIN (ANALYZE, FORMAT JSON) {sql}");
        let mut q = sqlx::query_scalar::<_, serde_json::Value>(sqlx::AssertSqlSafe(explain))
            .bind(w.tenant.org);
        // Replay the two production shapes with the matched cohort.
        if selected {
            q = q.bind(&ids);
        } else {
            q = q.bind(&people);
        }
        q = q
            .bind(&bounds)
            .bind(vec!["DISPATCHED_IN", "OUTSOURCED_ON_SITE", "FREELANCE"]);
        q = q
            .bind("AGE60")
            .bind(serde_json::to_value(rules.filing_rules()).unwrap())
            .bind(None::<time::OffsetDateTime>);
        if selected {
            q = q.bind(&ids);
        }
        let plan = q
            .bind(None::<time::OffsetDateTime>)
            .fetch_one(tx.as_mut())
            .await
            .unwrap();
        let mut observed = std::collections::BTreeSet::new();
        check_cohort(&plan[0]["Plan"], people.len(), &mut observed);
        assert_eq!(
            observed.len(),
            3,
            "sources, age facts and assignments must all be measured"
        );
        plans += 1;
    }
    assert_eq!(plans, 2, "expected companion and hydration");
}
