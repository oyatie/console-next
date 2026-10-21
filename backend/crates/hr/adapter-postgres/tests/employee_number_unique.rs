#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! MR-28: one holder per 사번 per tenant (0277's unique index). A legacy
//! duplicate stays outside the index, flagged, until a 사번 정정 (MR-8)
//! clears the flag and resolves the BW-10 listing; the index's violation is
//! a 409 for every writer, never a 500.

mod support;

use console_hr_adapter_postgres::HrError;
use console_hr_adapter_postgres::corrections::CorrectEmployeeRequest;
use console_platform_test_support::soft_passkey::passkey_service;
use serde_json::json;
use sqlx::PgPool;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use support::{SECOND, decide, world};

/// Owner-side write with triggers off (the fixture's way past the guards).
async fn replica(pool: &PgPool, sql: &str, id: Uuid) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query(sqlx::AssertSqlSafe(sql.to_owned()))
        .bind(id)
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

async fn flagged(pool: &PgPool, id: Uuid) -> (Option<String>, bool) {
    sqlx::query_as(
        "SELECT employee_number, employee_number_legacy_duplicate FROM employees WHERE id = $1",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_legacy_duplicate_leaves_the_listing_through_a_number_correction(pool: PgPool) {
    let w = world(&pool).await;
    replica(
        &pool,
        "UPDATE employees SET employee_number = 'N-1' WHERE id = $1",
        w.in_a,
    )
    .await;
    // A pre-0277 duplicate, as the migration flags it.
    replica(
        &pool,
        "UPDATE employees SET employee_number = 'N-1', employee_number_legacy_duplicate = true \
         WHERE id = $1",
        w.in_b,
    )
    .await;
    sqlx::query(
        "INSERT INTO employee_number_conflicts (org_id, employee_number, employee_ids) \
         VALUES ($1, 'N-1', ARRAY[$2, $3]::uuid[])",
    )
    .bind(w.org)
    .bind(w.in_a)
    .bind(w.in_b)
    .execute(&pool)
    .await
    .unwrap();

    // Only the migration sets the flag.
    let set =
        sqlx::query("UPDATE employees SET employee_number_legacy_duplicate = true WHERE id = $1")
            .bind(w.in_a)
            .execute(&pool)
            .await;
    assert!(
        set.unwrap_err()
            .to_string()
            .contains("only by the MR-28 migration")
    );

    // The runtime cannot put the duplicate into the index: 409, not 500.
    let mut tx = w.hr.pool().begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(w.org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let violation =
        sqlx::query("UPDATE employees SET employee_number_legacy_duplicate = false WHERE id = $1")
            .bind(w.in_b)
            .execute(tx.as_mut())
            .await
            .unwrap_err();
    drop(tx);
    let mapped = HrError::from(violation);
    assert_eq!(
        (mapped.status.as_u16(), mapped.code),
        (409, "employee_number_taken")
    );

    // A 사번 정정 of the flagged holder (a second person decides it) clears
    // the flag and resolves the listing.
    let updated_at: OffsetDateTime =
        sqlx::query_scalar("SELECT updated_at FROM employees WHERE id = $1")
            .bind(w.in_b)
            .fetch_one(&pool)
            .await
            .unwrap();
    let body: CorrectEmployeeRequest = serde_json::from_value(json!({
        "expected_updated_at": updated_at.format(&Rfc3339).unwrap(),
        "changes": { "employee_number": "N-2" },
        "reason_code": "DUPLICATE_NUMBER",
    }))
    .unwrap();
    let outcome =
        w.hr.correct_employee(w.hr(w.hr_one), &passkey_service(), w.in_b, body, SECOND)
            .await
            .unwrap();
    let request = outcome
        .pending_request
        .expect("a 사번 정정 needs a second person");
    w.hr.decide_change_request(w.hr(w.hr_two), request.id, decide("APPLY"), SECOND)
        .await
        .unwrap();
    assert_eq!(flagged(&pool, w.in_b).await, (Some("N-2".into()), false));
    let resolved_by: Option<Uuid> = sqlx::query_scalar(
        "SELECT resolved_by FROM employee_number_conflicts WHERE org_id = $1 AND employee_number = 'N-1'",
    )
    .bind(w.org)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(resolved_by, Some(w.hr_two));
}
