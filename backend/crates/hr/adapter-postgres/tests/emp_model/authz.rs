//! Fail closed: every EMP-MODEL entry point refuses a same-org caller below
//! the org-wide directory-manager tier, and a refused write leaves no row.

use console_hr_adapter_postgres::profile::ConfirmProbationRequest;
use console_hr_domain::contract::ContractKind;
use console_kernel_core::{BranchId, BranchScope, UserId};
use console_platform_authz::{Principal, Role};
use serde_json::json;
use sqlx::PgPool;
use std::collections::BTreeSet;
use uuid::Uuid;

use crate::fixture::{contract, fixture, ops};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn below_org_wide_manager_every_entry_point_is_refused(pool: PgPool) {
    let f = fixture(pool, true).await;
    let org = f.principal.org_id;
    let callers = [
        // A branch admin: not org-wide, so not the pay/ID tier.
        Principal::new(
            UserId::new(),
            org,
            BTreeSet::from([Role::Admin]),
            BranchScope::single(BranchId::new()),
        ),
        // A fresh self-signup member with all-branch scope.
        Principal::new(
            UserId::new(),
            org,
            BTreeSet::from([Role::Member]),
            BranchScope::All,
        ),
    ];
    for who in callers {
        let p = || who.clone();
        let e = f.employee;
        let statuses = [
            f.hr.employment_facts(p(), e).await.unwrap_err().status,
            f.hr.patch_employment_facts(
                p(),
                e,
                ops(json!([
                    { "op": "test", "path": "/birth_date", "value": null },
                    { "op": "replace", "path": "/birth_date", "value": "1990-01-01" }
                ])),
            )
            .await
            .unwrap_err()
            .status,
            f.hr.confirm_probation(p(), e, ConfirmProbationRequest { expected: vec![] })
                .await
                .unwrap_err()
                .status,
            f.hr.employee_contracts(p(), e).await.unwrap_err().status,
            f.hr.record_contract(
                p(),
                e,
                Uuid::new_v4(),
                contract(ContractKind::OpenEnded, "2026-09-01", None),
            )
            .await
            .unwrap_err()
            .status,
            f.hr.onboarding_checklist(p(), e).await.unwrap_err().status,
        ];
        assert!(statuses.iter().all(|s| s.as_u16() == 403), "{statuses:?}");
    }
    let (contracts, birth): (i64, Option<time::Date>) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM employee_contracts WHERE employee_id = $1), \
         (SELECT birth_date FROM employees WHERE id = $1)",
    )
    .bind(f.employee)
    .fetch_one(&f.owner)
    .await
    .unwrap();
    assert_eq!((contracts, birth), (0, None));
}
