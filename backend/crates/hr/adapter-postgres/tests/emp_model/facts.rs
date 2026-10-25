// SPDX-License-Identifier: LicenseRef-Proprietary
//! E3/E4/E5 facts PATCH and the F5 probation confirmation.

use console_hr_adapter_postgres::contract::RecordContractRequest;
use console_hr_adapter_postgres::profile::ConfirmProbationRequest;
use console_hr_domain::checklist::{ChecklistItem, ItemState};
use console_hr_domain::contract::ContractKind;
use console_kernel_core::{BranchScope, OrgId, UserId};
use console_platform_authz::{Principal, Role};
use serde_json::json;
use sqlx::PgPool;
use std::collections::BTreeSet;
use uuid::Uuid;

use crate::fixture::{contract, fixture, ops};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn facts_patch_is_tested_normalised_and_pay_is_first_record_only(pool: PgPool) {
    let f = fixture(pool, true).await;
    let p = || f.principal.clone();
    let untested = ops(json!([{ "op": "replace", "path": "/birth_date", "value": "1994-03-02" }]));
    let refused =
        f.hr.patch_employment_facts(p(), f.employee, untested)
            .await
            .unwrap_err();
    assert_eq!(
        (refused.status.as_u16(), refused.code),
        (422, "precondition_missing")
    );

    let edit = ops(json!([
        { "op": "test", "path": "/birth_date", "value": null },
        { "op": "replace", "path": "/birth_date", "value": "1994-03-02" },
        { "op": "test", "path": "/work_email", "value": null },
        { "op": "replace", "path": "/work_email", "value": " Kim@Corp.EXAMPLE.COM " },
        { "op": "test", "path": "/id_type", "value": null },
        { "op": "replace", "path": "/id_type", "value": "NOT_ISSUED" },
        { "op": "test", "path": "/employment/pay_unit", "value": null },
        { "op": "replace", "path": "/employment/pay_unit", "value": "MONTHLY" },
        { "op": "test", "path": "/employment/base_pay_won", "value": null },
        { "op": "replace", "path": "/employment/base_pay_won", "value": 3_100_000 }
    ]));
    let facts =
        f.hr.patch_employment_facts(p(), f.employee, edit)
            .await
            .unwrap();
    assert_eq!(facts.work_email.as_deref(), Some("Kim@corp.example.com"));
    assert_eq!(
        facts.employment.as_ref().unwrap().base_pay_won,
        Some(3_100_000)
    );
    // MR-8: the first recording is ledgered like any correction.
    let ledger: Vec<(String, Option<serde_json::Value>, String)> = sqlx::query_as(
        "SELECT field, old_value, reason_code FROM employee_corrections \
         WHERE employee_id = $1 ORDER BY field",
    )
    .bind(f.employee)
    .fetch_all(&f.owner)
    .await
    .unwrap();
    assert_eq!(
        ledger,
        vec![
            (
                "base_pay".into(),
                Some(json!("3000000.00")),
                "FIRST_RECORD".into()
            ),
            ("birth_date".into(), None, "FIRST_RECORD".into()),
            ("id_type".into(), None, "FIRST_RECORD".into()),
            ("pay_unit".into(), None, "FIRST_RECORD".into()),
            ("work_email".into(), None, "FIRST_RECORD".into()),
        ]
    );
    // ME-3: a stale test whose write the record already holds → no conflict.
    let same = ops(json!([
        { "op": "test", "path": "/birth_date", "value": null },
        { "op": "replace", "path": "/birth_date", "value": "1994-03-02" }
    ]));
    f.hr.patch_employment_facts(p(), f.employee, same)
        .await
        .unwrap();

    let stale = ops(json!([
        { "op": "test", "path": "/birth_date", "value": null },
        { "op": "replace", "path": "/birth_date", "value": "1990-01-01" }
    ]));
    let conflict =
        f.hr.patch_employment_facts(p(), f.employee, stale)
            .await
            .unwrap_err();
    assert_eq!(
        (conflict.status.as_u16(), conflict.code),
        (409, "field_conflict")
    );

    let repay = ops(json!([
        { "op": "test", "path": "/employment/base_pay_won", "value": 3_100_000 },
        { "op": "replace", "path": "/employment/base_pay_won", "value": 3_200_000 }
    ]));
    let correction =
        f.hr.patch_employment_facts(p(), f.employee, repay)
            .await
            .unwrap_err();
    assert_eq!(correction.code, "correction_required");

    let read_only = ops(json!([
        { "op": "test", "path": "/hire_date", "value": "2026-09-01" },
        { "op": "replace", "path": "/hire_date", "value": "2026-01-01" }
    ]));
    assert_eq!(
        f.hr.patch_employment_facts(p(), f.employee, read_only)
            .await
            .unwrap_err()
            .status,
        422
    );
    let future = ops(json!([
        { "op": "test", "path": "/birth_date", "value": "1994-03-02" },
        { "op": "replace", "path": "/birth_date", "value": "2999-01-01" }
    ]));
    assert_eq!(
        f.hr.patch_employment_facts(p(), f.employee, future)
            .await
            .unwrap_err()
            .status,
        422
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn probation_is_dated_then_confirmed_once(pool: PgPool) {
    let f = fixture(pool, true).await;
    let p = || f.principal.clone();
    let before_hire = ops(json!([
        { "op": "test", "path": "/employment/probation_end_date", "value": null },
        { "op": "replace", "path": "/employment/probation_end_date", "value": "2026-08-31" }
    ]));
    assert_eq!(
        f.hr.patch_employment_facts(p(), f.employee, before_hire)
            .await
            .unwrap_err()
            .status,
        422
    );
    let date = ops(json!([
        { "op": "test", "path": "/employment/probation_end_date", "value": null },
        { "op": "replace", "path": "/employment/probation_end_date", "value": "2026-11-30" }
    ]));
    f.hr.patch_employment_facts(p(), f.employee, date)
        .await
        .unwrap();
    // A recorded date is re-dated only by a correction (MR-8).
    let redate_open = ops(json!([
        { "op": "test", "path": "/employment/probation_end_date", "value": "2026-11-30" },
        { "op": "replace", "path": "/employment/probation_end_date", "value": "2026-12-15" }
    ]));
    assert_eq!(
        f.hr.patch_employment_facts(p(), f.employee, redate_open)
            .await
            .unwrap_err()
            .code,
        "correction_required"
    );

    let expect = |value: &str| -> ConfirmProbationRequest {
        serde_json::from_value(
            json!({ "expected": [{ "path": "/employment/probation_end_date", "value": value }] }),
        )
        .unwrap()
    };
    let stale =
        f.hr.confirm_probation(p(), f.employee, expect("2026-12-31"))
            .await
            .unwrap_err();
    assert_eq!(stale.code, "stale_facts");
    let confirmed =
        f.hr.confirm_probation(p(), f.employee, expect("2026-11-30"))
            .await
            .unwrap();
    let at = confirmed
        .employment
        .as_ref()
        .unwrap()
        .probation_confirmed_at;
    assert!(at.is_some());
    let again =
        f.hr.confirm_probation(p(), f.employee, expect("2026-11-30"))
            .await
            .unwrap();
    assert_eq!(again.employment.unwrap().probation_confirmed_at, at);
    let redate = ops(json!([
        { "op": "test", "path": "/employment/probation_end_date", "value": "2026-11-30" },
        { "op": "replace", "path": "/employment/probation_end_date", "value": "2026-12-31" }
    ]));
    assert_eq!(
        f.hr.patch_employment_facts(p(), f.employee, redate)
            .await
            .unwrap_err()
            .status,
        409
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn former_employee_cannot_record_first_employment_facts(pool: PgPool) {
    let f = fixture(pool, true).await;
    exit_employee(&f).await;
    let patch = ops(json!([
        { "op": "test", "path": "/birth_date", "value": null },
        { "op": "replace", "path": "/birth_date", "value": "1994-03-02" }
    ]));
    let error =
        f.hr.patch_employment_facts(f.principal.clone(), f.employee, patch)
            .await
            .unwrap_err();
    assert_eq!(
        (error.status.as_u16(), error.code),
        (409, "employee_exited_read_only")
    );
    assert_eq!(
        f.hr.employment_facts(f.principal.clone(), f.employee)
            .await
            .unwrap()
            .birth_date,
        None
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn former_employee_cannot_confirm_probation(pool: PgPool) {
    let f = fixture(pool, true).await;
    f.hr.patch_employment_facts(
        f.principal.clone(),
        f.employee,
        ops(json!([
            { "op": "test", "path": "/employment/probation_end_date", "value": null },
            { "op": "replace", "path": "/employment/probation_end_date", "value": "2026-11-30" }
        ])),
    )
    .await
    .unwrap();
    exit_employee(&f).await;
    let request = serde_json::from_value(json!({
        "expected": [{ "path": "/employment/probation_end_date", "value": "2026-11-30" }]
    }))
    .unwrap();
    let error =
        f.hr.confirm_probation(f.principal.clone(), f.employee, request)
            .await
            .unwrap_err();
    assert_eq!(
        (error.status.as_u16(), error.code),
        (409, "employee_exited_read_only")
    );
    assert_eq!(
        f.hr.employment_facts(f.principal.clone(), f.employee)
            .await
            .unwrap()
            .employment
            .unwrap()
            .probation_confirmed_at,
        None
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn former_employee_cannot_record_contract(pool: PgPool) {
    let f = fixture(pool, true).await;
    exit_employee(&f).await;
    let error =
        f.hr.record_contract(
            f.principal.clone(),
            f.employee,
            Uuid::new_v4(),
            contract(ContractKind::OpenEnded, "2026-09-01", None),
        )
        .await
        .unwrap_err();
    assert_eq!(
        (error.status.as_u16(), error.code),
        (409, "employee_exited_read_only")
    );
    assert!(
        f.hr.employee_contracts(f.principal.clone(), f.employee)
            .await
            .unwrap()
            .items
            .is_empty()
    );
}

async fn exit_employee(f: &crate::fixture::Fixture) {
    sqlx::query(
        "UPDATE employees SET employment_status='EXITED', exit_date='2026-12-01' WHERE id=$1",
    )
    .bind(f.employee)
    .execute(&f.owner)
    .await
    .unwrap();
}
