// SPDX-License-Identifier: LicenseRef-Proprietary
//! Enforce `NOT_ISSUED` strictly for `PRE_HIRE` employment status on profile facts writes.

use console_hr_adapter_postgres::directory::types::CreateEmployeeRequest;
use console_hr_domain::profile::enums::IdType;
use console_leave_adapter_postgres::PgLeaveStore;
use serde_json::json;
use sqlx::PgPool;
use std::sync::Arc;
use uuid::Uuid;

use crate::fixture::{fixture, ops};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn not_issued_id_type_is_refused_for_active_and_allowed_for_pre_hire(pool: PgPool) {
    let f = fixture(pool, true).await;
    let p = || f.principal.clone();

    let active_not_issued = ops(json!([
        { "op": "test", "path": "/id_type", "value": null },
        { "op": "replace", "path": "/id_type", "value": "NOT_ISSUED" }
    ]));
    assert_eq!(
        f.hr.patch_employment_facts(p(), f.employee, active_not_issued)
            .await
            .unwrap_err()
            .status,
        422
    );

    sqlx::query(
        "UPDATE employees SET employment_status = 'PRE_HIRE', hire_date = '2029-01-01', hire_on = '2029-01-01' WHERE id = $1",
    )
    .bind(f.employee)
    .execute(&f.owner)
    .await
    .unwrap();
    let prehire_not_issued = ops(json!([
        { "op": "test", "path": "/id_type", "value": null },
        { "op": "replace", "path": "/id_type", "value": "NOT_ISSUED" }
    ]));
    let patched =
        f.hr.patch_employment_facts(p(), f.employee, prehire_not_issued)
            .await
            .unwrap();
    assert_eq!(patched.id_type, Some(IdType::NotIssued));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn create_employee_enforces_case_insensitive_prehire_not_issued_uniqueness_without_500(
    pool: PgPool,
) {
    let f = fixture(pool, false).await;
    let org_id = *f.principal.org_id.as_uuid();
    let actor_id = *f.principal.user_id.as_uuid();
    let unit_id = Uuid::new_v4();
    sqlx::query("INSERT INTO org_units (org_id, id) VALUES ($1, $2)")
        .bind(org_id)
        .bind(unit_id)
        .execute(&f.owner)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO org_unit_revisions \
         (org_id, org_unit_id, version, command_id, actor_id, payload_digest, attributes, receipt) \
         VALUES ($1, $2, 1, gen_random_uuid(), $3, decode(repeat('00', 32), 'hex'), \
                 '{\"name\": \"site\", \"kind\": \"site\"}'::jsonb, '{}'::jsonb)",
    )
    .bind(org_id)
    .bind(unit_id)
    .bind(actor_id)
    .execute(&f.owner)
    .await
    .unwrap();

    let inbox = Arc::new(console_inbox_adapter_postgres::PgInboxStore::new(
        f.hr.pool().clone(),
    ));
    let leave_store = PgLeaveStore::new(f.hr.pool().clone(), inbox);

    let first_req: CreateEmployeeRequest = serde_json::from_value(json!({
        "idempotency_key": Uuid::new_v4().to_string(),
        "company": "Acme Co",
        "employment_type": "REGULAR",
        "phone": "010-1234-5678",
        "org_unit_id": unit_id,
        "position": "Staff",
        "site": "HQ",
        "name": "Alex Kim",
        "hire_date": "2029-05-01",
        "birth_date": "1995-05-05",
        "id_type": "NOT_ISSUED"
    }))
    .unwrap();
    let (status, _) = console_platform_request_context::scope_org(
        f.principal.org_id,
        f.hr.create_employee(f.principal.clone(), leave_store.clone(), first_req),
    )
    .await
    .unwrap();
    assert_eq!(status, 201);

    // Case-differing second registration is caught by duplicate_candidates (409 duplicate_candidate)
    let second_req: CreateEmployeeRequest = serde_json::from_value(json!({
        "idempotency_key": Uuid::new_v4().to_string(),
        "company": "Acme Co",
        "employment_type": "REGULAR",
        "phone": "010-9999-0000",
        "org_unit_id": unit_id,
        "position": "Staff",
        "site": "HQ",
        "name": "alex kim",
        "hire_date": "2029-05-01",
        "birth_date": "1995-05-05",
        "id_type": "NOT_ISSUED"
    }))
    .unwrap();
    let err = console_platform_request_context::scope_org(
        f.principal.org_id,
        f.hr.create_employee(f.principal.clone(), leave_store.clone(), second_req),
    )
    .await
    .unwrap_err();
    assert_eq!(
        (err.status.as_u16(), err.code),
        (409, "duplicate_candidate")
    );

    // Even if duplicate_override names the first candidate, unique index maps 23505 to 409 (never 500)
    let first_id: Uuid = sqlx::query_scalar(
        "SELECT id FROM employees WHERE org_id = $1 AND name = 'Alex Kim' AND id_type = 'NOT_ISSUED'",
    )
    .bind(org_id)
    .fetch_one(&f.owner)
    .await
    .unwrap();
    let override_req: CreateEmployeeRequest = serde_json::from_value(json!({
        "idempotency_key": Uuid::new_v4().to_string(),
        "company": "Acme Co",
        "employment_type": "REGULAR",
        "phone": "010-9999-0000",
        "org_unit_id": unit_id,
        "position": "Staff",
        "site": "HQ",
        "name": "alex kim",
        "hire_date": "2029-05-01",
        "birth_date": "1995-05-05",
        "id_type": "NOT_ISSUED",
        "duplicate_override": {
            "candidate_ids": [first_id],
            "reason_code": "OTHER",
            "note": "regression test"
        }
    }))
    .unwrap();
    let err2 = console_platform_request_context::scope_org(
        f.principal.org_id,
        f.hr.create_employee(f.principal.clone(), leave_store, override_req),
    )
    .await
    .unwrap_err();
    assert_eq!(
        (err2.status.as_u16(), err2.code),
        (409, "duplicate_candidate")
    );
}
