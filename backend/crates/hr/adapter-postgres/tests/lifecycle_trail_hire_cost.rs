// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]
#[path = "emp_create/fixture.rs"]
mod fixture;
#[path = "support/trail_queries.rs"]
mod trail_queries;
use console_inbox_adapter_postgres::PgInboxStore;
use console_leave_adapter_postgres::PgLeaveStore;
use sqlx::PgPool;
use std::{sync::Arc, time::Instant};
use tracing::instrument::WithSubscriber;
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn hire_trail_writes_are_batched(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let mut body = f.body("hire-cost", "REGULAR");
    body.home_branch_id = None;
    body.hire_date = Some(console_hr_adapter_postgres::clock::today_kst().to_string());
    let queries = trail_queries::Queries::default();
    let store = PgLeaveStore::new(f.rt.clone(), Arc::new(PgInboxStore::new(f.rt.clone())));
    let start = Instant::now();
    f.hr.create_employee(f.principal.clone(), store, body)
        .with_subscriber(queries.clone())
        .await
        .unwrap();
    let statements = queries.statements();
    eprintln!(
        "one product hire: {:?}, {} SQL statements",
        start.elapsed(),
        statements.len()
    );
    for statement in &statements {
        eprintln!("{statement}");
    }
    assert!(
        statements.len() <= 75,
        "a hire must keep its trail writes batched: {} statements",
        statements.len()
    );
    let codes: Vec<String> = sqlx::query_scalar("SELECT DISTINCT due_register_code FROM case_template_items WHERE template_key='HIRE' AND due_register_code IS NOT NULL")
        .fetch_all(&pool).await.unwrap();
    let codes: Vec<_> = codes
        .iter()
        .map(|code| console_compliance_domain::statutory::codes::resolve(code).to_owned())
        .collect();
    let mut conn = pool.acquire().await.unwrap();
    let full = console_platform_db::statutory_read::load_statutory_register(&mut conn)
        .await
        .unwrap();
    let today = console_hr_adapter_postgres::clock::today_kst();
    let expected: Vec<_> = full
        .filing_rules()
        .iter()
        .filter(|rule| {
            codes.contains(&rule.code)
                && (rule.in_force(today).unwrap()
                    || !full.filing_rules().iter().any(|earlier| {
                        earlier.code == rule.code && earlier.effective_from < rule.effective_from
                    }))
        })
        .cloned()
        .collect();
    let filing_reads: Vec<_> = statements
        .iter()
        .filter(|sql| sql.contains("SELECT filing_rule,trigger_event_kinds"))
        .collect();
    assert_eq!(filing_reads.len(), 1);
    assert!(
        filing_reads[0].contains(&format!("rows_returned={} ", expected.len())),
        "a hire loads the case's rule periods and first filing dates: {}",
        filing_reads[0]
    );
    let stored: Vec<(String, serde_json::Value)> = sqlx::query_as("SELECT i.due_rule_ref,i.due_basis->'dates' FROM lifecycle_case_items i JOIN lifecycle_cases c ON c.org_id=i.org_id AND c.id=i.case_id WHERE c.org_id=$1 AND c.kind='HIRE' AND i.kind='FIL'")
        .bind(f.principal.org_id.as_uuid()).fetch_all(&pool).await.unwrap();
    assert_eq!(stored.len(), codes.len());
    for (code, basis) in stored {
        let rule = full.filing_rule_by_code(&code, today).unwrap().unwrap();
        let dates = console_compliance_domain::statutory::filing::dates(
            rule,
            &console_compliance_domain::statutory::filing::FilingAnchors {
                effective_date: Some(today),
                acquire_date: Some(today),
                exit_date: Some(today),
                loss_date: Some(rule.loss_on(today).unwrap()),
                work_month: Some(today),
                ..Default::default()
            },
            &[],
        )
        .unwrap();
        assert_eq!(
            basis,
            serde_json::to_value(dates).unwrap(),
            "preserve {code}'s filing dates"
        );
    }
    let links = statements
        .iter()
        .filter(|s| s.contains("UPDATE lifecycle_case_items SET filing_obligation_id"))
        .count();
    assert!(
        links <= 1,
        "link all filing obligations together, got {links} updates"
    );
}
