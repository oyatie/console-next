// SPDX-License-Identifier: LicenseRef-Proprietary
use super::age_scale;
use serde_json::Value;
use sqlx::PgPool;

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
    let mut q = sqlx::query_scalar::<_, Value>(sqlx::AssertSqlSafe(explain))
        .bind(org)
        .bind(bounds)
        .bind(vec!["DISPATCHED_IN", "OUTSOURCED_ON_SITE", "FREELANCE"])
        .bind(age_scale::inbox_ids(pool, org).await)
        .bind("AGE60");
    if sql.contains("age_rules AS") {
        let rules: Value = sqlx::query_scalar(
            "SELECT jsonb_agg(filing_rule) FROM statutory_rules WHERE filing_rule IS NOT NULL",
        )
        .fetch_one(&mut *conn)
        .await
        .unwrap();
        q = q
            .bind(rules)
            .bind(None::<time::OffsetDateTime>)
            .bind(age_scale::inbox_ids(pool, org).await);
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
