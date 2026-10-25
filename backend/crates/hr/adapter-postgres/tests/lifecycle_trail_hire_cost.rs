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
    let f = fixture::fixture(pool).await;
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
    let links = statements
        .iter()
        .filter(|s| s.contains("UPDATE lifecycle_case_items SET filing_obligation_id"))
        .count();
    assert!(
        links <= 1,
        "link all filing obligations together, got {links} updates"
    );
}
