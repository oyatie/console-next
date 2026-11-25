// SPDX-License-Identifier: LicenseRef-Proprietary
//! A void that waits for a payroll roster writer holding the person reads their
//! work records after the wait, so the line that roster commits refuses it.

use console_platform_test_support::soft_passkey::passkey_service;
use sqlx::PgPool;
use uuid::Uuid;

use crate::fixture::fixture;
use crate::void::{SECOND, go_live, register, version, void_body};

/// Whether some session of this test's database is waiting on a lock, polled
/// for up to five seconds.
async fn a_session_waits_on_a_lock(pool: &PgPool) -> bool {
    for _ in 0..250 {
        let waiting: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity \
             WHERE wait_event_type = 'Lock' AND datname = current_database()) \
             FROM pg_sleep(0.02)",
        )
        .fetch_one(pool)
        .await
        .unwrap();
        if waiting {
            return true;
        }
    }
    false
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_void_that_waits_for_a_roster_writer_is_refused_for_the_line_it_wrote(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    // A pending hire: nothing else stands between them and a void.
    let id = register(&f, "race-1", "2030-01-02", "").await;
    let org = *f.principal.org_id.as_uuid();
    go_live(&pool, org).await;
    let expected = version(&pool, id).await;
    let run: Uuid = sqlx::query_scalar(
        "INSERT INTO payroll_draft_runs (org_id, period_start, period_end, source_label) \
         VALUES ($1, DATE '2026-06-01', DATE '2026-06-30', 'race') RETURNING id",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .unwrap();
    // What the roster writer does: hold the member FOR KEY SHARE and write their line.
    let mut roster = pool.begin().await.unwrap();
    sqlx::query(
        "WITH m AS (SELECT id FROM employees WHERE org_id = $1 AND id = $2 FOR KEY SHARE) \
         INSERT INTO payroll_draft_lines \
           (org_id, run_id, employee_id, employee_source_key, employee_display_name, employee_company) \
         SELECT $1, $3, id, 'race-1', 'Race', 'SAE' FROM m",
    )
    .bind(org)
    .bind(id)
    .bind(run)
    .execute(&mut *roster)
    .await
    .unwrap();
    let passkeys = passkey_service();
    let (voided, waited) = tokio::join!(
        f.hr.void_employee(
            f.principal.clone(),
            &passkeys,
            id,
            void_body(expected, false),
            SECOND,
        ),
        async {
            // The roster commits only once the void is seen waiting for it.
            let waited = a_session_waits_on_a_lock(&pool).await;
            roster.commit().await.unwrap();
            waited
        }
    );
    assert_eq!(
        (
            waited,
            voided
                .map(|outcome| outcome.status)
                .map_err(|error| (error.status.as_u16(), error.code))
        ),
        (true, Err((409, "employee_void_has_work_records")))
    );
}
