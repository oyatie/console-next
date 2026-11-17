// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]
#[path = "statutory/age_explain.rs"]
mod age_explain;
#[path = "statutory/age_scale.rs"]
mod age_scale;
mod support;
#[path = "support/trail_queries.rs"]
mod trail_queries;
#[path = "statutory/world.rs"]
mod world;
use console_hr_adapter_postgres::statutory::FilingQuery;
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
    age_explain::explain_age(&pool, w.tenant.org, &captured).await;
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
            age_explain::explain_age(&pool, w.tenant.org, &statements).await;
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
