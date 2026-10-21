//! A voided record's sealed 주민등록번호 goes with its personal data (0296
//! trigger under the 0292 SECURITY DEFINER tombstone).

use console_hr_adapter_postgres::registration_void::SetupDeleteRequest;
use serde_json::json;
use sqlx::PgPool;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use crate::fixture::fixture;

pub(crate) async fn seal_dummy(pool: &PgPool, org: Uuid, employee: Uuid, recorded_by: Uuid) {
    sqlx::query(
        "INSERT INTO employee_rrn (org_id, employee_id, rrn_hmac, hmac_key_version, ciphertext, \
         nonce, dek_wrapped, dek_nonce, key_version, masked, source, recorded_by) \
         VALUES ($1, $2, $3, 1, $4, $5, $4, $5, 1, '900101-1******', 'FORM', $6)",
    )
    .bind(org)
    .bind(employee)
    .bind(vec![7u8; 32])
    .bind(vec![1u8; 40])
    .bind(vec![2u8; 24])
    .bind(recorded_by)
    .execute(pool)
    .await
    .unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_tombstone_destroys_the_sealed_rrn(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    let org = *f.principal.org_id.as_uuid();
    let mut body = f.body("rrn-1", "REGULAR");
    body.hire_date = Some("2026-09-01".into());
    body.employee_number = "R-001".into();
    let id = f.create(body).await.unwrap().employee.id;
    seal_dummy(&pool, org, id, *f.principal.user_id.as_uuid()).await;
    let at: OffsetDateTime = sqlx::query_scalar("SELECT updated_at FROM employees WHERE id = $1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let request: SetupDeleteRequest = serde_json::from_value(json!({
        "expected_updated_at": at.format(&Rfc3339).unwrap(),
        "reason_code": "DUPLICATE_ENTRY", "register_kept": false,
    }))
    .unwrap();
    f.hr.setup_delete_employee(f.principal.clone(), id, request)
        .await
        .unwrap();
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM employee_rrn WHERE employee_id = $1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
}
