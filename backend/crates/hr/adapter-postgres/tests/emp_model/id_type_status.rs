// SPDX-License-Identifier: LicenseRef-Proprietary
//! Enforce `NOT_ISSUED` strictly for `PRE_HIRE` employment status on profile facts writes.

use console_hr_domain::profile::enums::IdType;
use serde_json::json;
use sqlx::PgPool;

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
