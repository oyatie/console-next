// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Scale proof for registration through the batched product core.

#[allow(dead_code)]
#[path = "emp_create/fixture.rs"]
mod fixture;
#[allow(dead_code)]
#[path = "support/trail_queries.rs"]
mod trail_queries;

#[path = "support/registration_hires.rs"]
mod registration_hires;

use std::time::{Duration, Instant};

use sqlx::PgPool;
use tracing::instrument::WithSubscriber;

// The CI profile gives budget tests exclusive execution, separate from migrations.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn two_thousand_registrations_write_canonical_heads_and_onboarding_cases_under_budget(
    pool: PgPool,
) {
    let f = fixture::fixture(pool.clone()).await;
    let people = 2_000;
    let hiring = Instant::now();
    let registration_queries = trail_queries::Queries::default();
    let employees = registration_hires::hires(&f, people)
        .with_subscriber(registration_queries.clone())
        .await;
    let elapsed = hiring.elapsed();
    assert!(
        elapsed < Duration::from_secs(90),
        "2,000 hires exceeded 90s: {elapsed:?}"
    );
    let registration_statements = registration_queries.statements();
    for sql in [
        "INSERT INTO employees (",
        "INSERT INTO persons (",
        "INSERT INTO employment_heads",
        "INSERT INTO employee_lifecycle_events",
        "INSERT INTO lifecycle_cases (org_id,id,kind,variant",
        "INSERT INTO lifecycle_case_items (org_id,case_id,item_key",
        "INSERT INTO employee_employment_profiles (",
        "UPDATE employee_create_idempotency SET employee_id",
    ] {
        assert_eq!(
            registration_statements
                .iter()
                .filter(|s| s.contains(sql))
                .count(),
            1,
            "one batched registration statement: {sql}"
        );
    }
    eprintln!(
        "batched registration of {people} employees: {:?}",
        hiring.elapsed()
    );
    let counts: (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM employment_source_bindings WHERE org_id=$1 AND employee_id=ANY($2)), \
         (SELECT count(*) FROM employee_lifecycle_events WHERE org_id=$1 AND employee_id=ANY($2) AND event_type='ONBOARD' AND state='APPLIED'), \
         (SELECT count(*) FROM lifecycle_cases WHERE org_id=$1 AND employee_id=ANY($2) AND kind='HIRE')",
    ).bind(f.principal.org_id.as_uuid()).bind(&employees).fetch_one(&pool).await.unwrap();
    let expected = i64::try_from(people).unwrap();
    assert_eq!(counts, (expected, expected, expected));
}
