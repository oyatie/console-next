// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Scale proof for registration through the batched product core.

#[allow(dead_code)]
#[path = "emp_create/fixture.rs"]
mod fixture;
#[allow(dead_code)]
#[path = "support/trail_queries.rs"]
mod trail_queries;

use std::time::Instant;

use console_hr_adapter_postgres::clock::today_kst;
use console_hr_adapter_postgres::directory::{
    create_core::write_registrations_core, create_prepare::RegistrationInput,
    normalize::normalize_create_employee_request,
};
use sqlx::PgPool;
use time::Duration;
use tracing::instrument::WithSubscriber;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn two_thousand_registrations_write_canonical_heads_and_onboarding_cases_together(
    pool: PgPool,
) {
    let f = fixture::fixture(pool.clone()).await;
    let people = 2_000;
    let hiring = Instant::now();
    let requests: Vec<_> = (0..people)
        .map(|n| {
            let mut body = f.body(&format!("lifecycle-scale-{n}"), "REGULAR");
            body.name = format!("Synthetic employee {n}");
            body.position = "Synthetic position".into();
            body.site = "Synthetic site".into();
            body.employee_number = format!("TRAIL-{n}");
            body.hire_date = Some((today_kst() - Duration::days(1)).to_string());
            body.home_branch_id = None;
            normalize_create_employee_request(body).unwrap()
        })
        .collect();
    let hashes: Vec<_> = requests
        .iter()
        .map(|request| {
            console_hr_adapter_postgres::digest::sha256_hex(
                serde_json::to_string(request).unwrap().as_bytes(),
            )
        })
        .collect();
    let inputs: Vec<_> = requests
        .iter()
        .zip(&hashes)
        .map(|(request, hash)| RegistrationInput {
            request,
            request_hash: hash,
            employee_id: Uuid::new_v4(),
        })
        .collect();
    let mut tx = f.rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(f.principal.org_id.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let registration_queries = trail_queries::Queries::default();
    let registered = write_registrations_core(
        &mut tx,
        *f.principal.org_id.as_uuid(),
        f.principal.user_id,
        &inputs,
    )
    .with_subscriber(registration_queries.clone())
    .await
    .unwrap();
    assert_eq!(registered.len(), people);
    let employees: Vec<_> = registered
        .iter()
        .zip(&inputs)
        .map(|(row, input)| {
            assert!(!row.replayed);
            assert_eq!(row.employee_id, input.employee_id);
            row.employee_id
        })
        .collect();
    tx.commit().await.unwrap();
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
