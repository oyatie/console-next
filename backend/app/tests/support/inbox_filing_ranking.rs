// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

pub async fn explain(pool: &PgPool, org: Uuid, page: &Value, events: &[Value], people: i32) {
    let event = events
        .iter()
        .find(|event| {
            event["fields"]["db.statement"].as_str().is_some_and(|sql| {
                sql.contains("paged AS MATERIALIZED (SELECT * FROM candidates")
                    && !sql.contains("inbox_id = ANY(")
            })
        })
        .expect("the traced inbox must rank insurance filings");
    let sql = event["fields"]["db.statement"].as_str().unwrap();
    let elapsed = event["fields"]["elapsed_secs"].as_f64().unwrap();
    let work = events
        .iter()
        .find(|event| {
            event["fields"]["message"] == "inbox source measured"
                && event["span"]["source"] == "HrInsurance"
        })
        .expect("the insurance source must report its work")["fields"]["work_seconds"]
        .as_f64()
        .unwrap();
    eprintln!(
        "filing ranking: people={people}, rows_returned={}, elapsed_secs={elapsed}, work_seconds={work}, nonranking_seconds={}",
        event["fields"]["rows_returned"],
        work - elapsed
    );
    let bounds: Value = sqlx::query_scalar("SELECT jsonb_agg(jsonb_build_object('code',code,'effective_from',effective_from,'earliest_event_on',NULL)) FROM lifecycle_filing_rules WHERE filing_rule IS NOT NULL")
        .fetch_one(pool).await.unwrap();
    let as_of = time::OffsetDateTime::parse(
        page["as_of"].as_str().unwrap(),
        &time::format_description::well_known::Rfc3339,
    )
    .unwrap();
    let runtime = console_platform_test_support::runtime_role_pool(pool).await;
    let statement = format!("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {sql}");
    let plan: Value = console_platform_db::with_org_conn::<_, _, console_platform_db::DbError>(
        &runtime,
        console_kernel_core::OrgId::from_uuid(org),
        move |tx| {
            Box::pin(async move {
                sqlx::query("SET LOCAL jit=off")
                    .execute(tx.as_mut())
                    .await?;
                Ok(sqlx::query_scalar(sqlx::AssertSqlSafe(statement))
                    .bind(org)
                    .bind(bounds)
                    .bind(vec!["DISPATCHED_IN", "OUTSOURCED_ON_SITE", "FREELANCE"])
                    .bind(as_of)
                    .bind(as_of)
                    .fetch_one(tx.as_mut())
                    .await?)
            })
        },
    )
    .await
    .unwrap();
    let relations = [
        "employees",
        "employee_person_bindings",
        "person_revisions",
        "employment_assignments",
    ];
    let mut loops = [0; 4];
    inspect(&plan[0]["Plan"], &relations, &mut loops);
    eprintln!(
        "filing ranking EXPLAIN: people={people}, relations={relations:?}, loops={loops:?}, execution_ms={}",
        plan[0]["Execution Time"]
    );
    assert!(
        loops[0] > 0 && loops[2] > 0 && loops.iter().all(|count| *count <= 4),
        "filing ranking must read person facts and placements as sets: people={people}, relations={relations:?}, loops={loops:?}"
    );
}

fn inspect(node: &Value, relations: &[&str; 4], loops: &mut [u64; 4]) {
    for (index, relation) in relations.iter().enumerate() {
        if node["Relation Name"] == *relation {
            loops[index] = loops[index].max(node["Actual Loops"].as_u64().unwrap());
        }
    }
    if let Some(children) = node["Plans"].as_array() {
        for child in children {
            inspect(child, relations, loops);
        }
    }
}
