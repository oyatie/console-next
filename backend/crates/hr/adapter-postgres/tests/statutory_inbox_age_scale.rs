// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]
#[path = "statutory/age_scale.rs"]
mod age_scale;
mod support;
#[path = "support/trail_queries.rs"]
mod trail_queries;
#[path = "statutory/world.rs"]
mod world;
use console_hr_adapter_postgres::statutory::FilingQuery;
use serde_json::Value;
use sqlx::PgPool;
use tracing::instrument::WithSubscriber;

// Tracing callsite interest is process-wide; serialize the scoped SQL collectors.
static QUERY_CAPTURE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn birthday_hydration_is_bounded_and_paging_preserves_panel_membership(pool: PgPool) {
    let _capture = QUERY_CAPTURE.lock().await;
    let w = world::world(&pool).await;
    let mut counts = Vec::new();
    let mut captured = Vec::new();
    for (size, due) in [(20, 6), (1999, 6)] {
        age_scale::seed(&pool, w.tenant.org, w.user, w.entity, w.site, size, due).await;
        let queries = trail_queries::Queries::default();
        let (page, _) = w
            .tenant
            .hr
            .insurance_inbox_page(
                support::principal(w.tenant.org, w.user),
                FilingQuery {
                    kind: Some("AGE60".into()),
                    state: Some("PENDING".into()),
                    limit: Some(50),
                    ..Default::default()
                },
                world::register_rules(&pool).await,
                None,
            )
            .with_subscriber(queries.clone())
            .await
            .unwrap();
        assert_eq!(page.items.len(), 6);
        let statements = queries.statements();
        let conversions = statements
            .iter()
            .filter(|s| s.contains("SELECT $1::date::timestamp AT TIME ZONE $2"))
            .count();
        eprintln!(
            "seed={size}, due={due}, per-row timestamp statements={conversions}, statements={}",
            statements.len()
        );
        counts.push(statements.len());
        captured = statements;
    }
    explain_age(&pool, w.tenant.org, &captured).await;
    assert_eq!(
        counts[0], counts[1],
        "candidate count must not grow SQL statement count"
    );
    let register = world::register_rules(&pool).await;
    let p = support::principal(w.tenant.org, w.user);
    let panel = w
        .tenant
        .hr
        .insurance_filings(
            p.clone(),
            FilingQuery {
                kind: Some("AGE60".into()),
                state: Some("PENDING".into()),
                limit: Some(200),
                ..Default::default()
            },
            register.clone(),
        )
        .await
        .unwrap();
    let expected: std::collections::BTreeSet<_> = panel
        .items
        .iter()
        .map(|t| (t.created_at, t.inbox_id()))
        .collect();
    let mut after = None;
    let mut seen = std::collections::BTreeSet::new();
    loop {
        let (page, _) = w
            .tenant
            .hr
            .insurance_inbox_page(
                p.clone(),
                FilingQuery {
                    kind: Some("AGE60".into()),
                    state: Some("PENDING".into()),
                    inbox_as_of: Some(time::OffsetDateTime::now_utc()),
                    limit: Some(2),
                    ..Default::default()
                },
                register.clone(),
                after.clone(),
            )
            .await
            .unwrap();
        for t in &page.items {
            assert!(
                seen.insert((t.created_at, t.inbox_id())),
                "duplicate birthday task"
            );
        }
        if page.next.is_none() {
            break;
        }
        let last = page.items.last().expect("a continuation must advance");
        after = Some(world::inbox_position(last));
    }
    assert_eq!(seen, expected);
    calendar_keys(&pool).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn many_due_birthdays_do_not_add_a_statement_per_task(pool: PgPool) {
    let _capture = QUERY_CAPTURE.lock().await;
    let w = world::world(&pool).await;
    let mut counts = Vec::new();
    for (size, due) in [(20, 20), (1999, 80)] {
        age_scale::seed(&pool, w.tenant.org, w.user, w.entity, w.site, size, due).await;
        let queries = trail_queries::Queries::default();
        let (page, exact) = w
            .tenant
            .hr
            .insurance_inbox_page(
                support::principal(w.tenant.org, w.user),
                FilingQuery {
                    kind: Some("AGE60".into()),
                    state: Some("PENDING".into()),
                    limit: Some(50),
                    ..Default::default()
                },
                world::register_rules(&pool).await,
                None,
            )
            .with_subscriber(queries.clone())
            .await
            .unwrap();
        assert_eq!(page.items.len(), if size == 20 { 20 } else { 50 });
        let statements = queries.statements();
        let conversions = statements
            .iter()
            .filter(|s| s.contains("SELECT $1::date::timestamp AT TIME ZONE $2"))
            .count();
        eprintln!(
            "many-due seed={size}, per-row timestamp statements={conversions}, statements={}",
            statements.len()
        );
        counts.push(statements.len());
        if size == 1999 {
            assert!(
                exact,
                "all birthday deadlines are assessed before the bounded hydration"
            );
            assert_eq!(page.total, i64::from(due));
            explain_age(&pool, w.tenant.org, &statements).await;
        }
    }
    assert_eq!(
        counts[0], counts[1],
        "accepted birthdays must not add SQL statements"
    );
}

async fn calendar_keys(pool: &PgPool) {
    let w = world::world(pool).await;
    let p = support::principal(w.tenant.org, w.user);
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE statutory_rules SET filing_rule=jsonb_set(filing_rule,'{age_trigger_years}','63') WHERE filing_rule->>'filing_kind'='AGE60'").execute(tx.as_mut()).await.unwrap();
    sqlx::query("UPDATE workplaces SET time_zone='Pacific/Kiritimati' WHERE org_id=$1 AND id=$2")
        .bind(w.tenant.org)
        .bind(w.site)
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE employees SET birth_date=NULL WHERE org_id=$1 AND id=$2")
        .bind(w.tenant.org)
        .bind(w.employee)
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE employee_lifecycle_events SET effective_date='2023-02-01',created_at='2023-02-01T00:00:00Z' WHERE org_id=$1 AND id=$2").bind(w.tenant.org).bind(w.event).execute(tx.as_mut()).await.unwrap();
    sqlx::query("UPDATE employment_assignments SET valid_from='2023-02-01' WHERE org_id=$1 AND employee_id=$2").bind(w.tenant.org).bind(w.employee).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO insurance_filing_records (org_id,event_id,filing_kind,insurer,version,action,actor,idempotency_key,request_hash,applicability_facts) VALUES ($1,$2,'AGE60','NPS',1,'ASSESS',$3,'leap-facts',repeat('a',64),$4)")
        .bind(w.tenant.org).bind(w.event).bind(w.user.as_uuid()).bind(serde_json::json!({"birth_date":"1964-02-29"})).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    let midnight = time::macros::datetime!(2027-02-27 10:00 UTC);
    let register = world::register_rules(pool).await;
    for (as_of, expected) in [(midnight - time::Duration::seconds(1), 0), (midnight, 1)] {
        let query = FilingQuery {
            kind: Some("AGE60".into()),
            state: Some("PENDING".into()),
            inbox_as_of: Some(as_of),
            ..Default::default()
        };
        let panel = w
            .tenant
            .hr
            .insurance_filings(p.clone(), query.clone(), register.clone())
            .await
            .unwrap();
        let (page, exact) = w
            .tenant
            .hr
            .insurance_inbox_page(p.clone(), query, register.clone(), None)
            .await
            .unwrap();
        assert_eq!(panel.total, expected);
        assert_eq!(page.total, expected);
        assert!(exact);
        if expected == 1 {
            assert_eq!(page.items[0].effective_date, "2027-02-28");
            assert_eq!(page.items[0].created_at, midnight);
            assert_eq!(panel.items[0].created_at, page.items[0].created_at);
        }
    }
}

async fn explain_age(pool: &PgPool, org: uuid::Uuid, captured: &[String]) {
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
