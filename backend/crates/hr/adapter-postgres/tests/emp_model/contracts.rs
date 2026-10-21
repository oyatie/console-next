//! G1 contract history and the E10 checklist.

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
async fn contract_history_is_idempotent_append_only_and_non_overlapping(pool: PgPool) {
    let f = fixture(pool, true).await;
    let p = || f.principal.clone();
    let key = Uuid::new_v4();
    let first = contract(ContractKind::FixedTerm, "2026-09-01", Some("2027-02-28"));
    let (row, created) =
        f.hr.record_contract(p(), f.employee, key, first.clone())
            .await
            .unwrap();
    assert!(created && row.in_force);
    let (replay, created) =
        f.hr.record_contract(p(), f.employee, key, first.clone())
            .await
            .unwrap();
    assert!(!created);
    assert_eq!(replay.id, row.id);
    let mut other = first.clone();
    other.wage_won += 1;
    assert_eq!(
        f.hr.record_contract(p(), f.employee, key, other)
            .await
            .unwrap_err()
            .status,
        409
    );
    let overlap = contract(ContractKind::FixedTerm, "2027-02-01", Some("2027-08-31"));
    let refused =
        f.hr.record_contract(p(), f.employee, Uuid::new_v4(), overlap)
            .await
            .unwrap_err();
    assert_eq!(
        (refused.status.as_u16(), refused.code),
        (409, "contract_overlap")
    );
    let named = &refused.refusals.unwrap()[0];
    assert_eq!(named["contract_id"], row.id.to_string());
    assert_eq!(named["start_date"], "2026-09-01");
    assert_eq!(
        f.hr.employee_contracts(p(), f.employee)
            .await
            .unwrap()
            .items
            .len(),
        1
    );
    let no_hours = RecordContractRequest {
        weekly_minutes: None,
        ..first.clone()
    };
    assert_eq!(
        f.hr.record_contract(p(), f.employee, Uuid::new_v4(), no_hours)
            .await
            .unwrap_err()
            .status,
        422
    );

    let fix = RecordContractRequest {
        end_date: Some("2027-03-31".into()),
        supersedes_id: Some(row.id),
        ..first.clone()
    };
    let (fixed, _) =
        f.hr.record_contract(p(), f.employee, Uuid::new_v4(), fix.clone())
            .await
            .unwrap();
    assert_eq!(
        f.hr.record_contract(p(), f.employee, Uuid::new_v4(), fix)
            .await
            .unwrap_err()
            .status,
        409
    );
    let renewal = contract(ContractKind::OpenEnded, "2027-04-01", None);
    f.hr.record_contract(p(), f.employee, Uuid::new_v4(), renewal)
        .await
        .unwrap();

    let list = f.hr.employee_contracts(p(), f.employee).await.unwrap();
    assert_eq!(list.items.len(), 3);
    let old = list.items.iter().find(|c| c.id == row.id).unwrap();
    assert_eq!(old.superseded_by, Some(fixed.id));
    assert!(!old.in_force);

    let update = sqlx::query("UPDATE employee_contracts SET wage_won = 1 WHERE id = $1")
        .bind(row.id)
        .execute(&f.owner)
        .await;
    assert!(update.is_err(), "employee_contracts must stay append-only");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn checklist_derives_from_facts_and_profile_less_rows_refuse_employment_edits(pool: PgPool) {
    let f = fixture(pool, false).await;
    let p = || f.principal.clone();
    let state = |list: &console_hr_adapter_postgres::checklist::OnboardingChecklist, item| {
        list.items.iter().find(|e| e.item == item).unwrap().state
    };
    let empty = f.hr.onboarding_checklist(p(), f.employee).await.unwrap();
    assert_eq!(
        state(&empty, ChecklistItem::ContractRecorded),
        ItemState::Open
    );
    assert_eq!(state(&empty, ChecklistItem::IdRegistered), ItemState::Open);
    assert_eq!(
        state(&empty, ChecklistItem::InsuranceAcquisitionReported),
        ItemState::NotTracked
    );

    let pay = ops(json!([
        { "op": "test", "path": "/employment/pay_unit", "value": null },
        { "op": "replace", "path": "/employment/pay_unit", "value": "MONTHLY" }
    ]));
    let no_profile =
        f.hr.patch_employment_facts(p(), f.employee, pay)
            .await
            .unwrap_err();
    // Not a field_conflict: the remedy is to register the employment.
    assert_eq!(
        (no_profile.status.as_u16(), no_profile.code),
        (409, "conflict")
    );

    let id = ops(json!([
        { "op": "test", "path": "/id_type", "value": null },
        { "op": "replace", "path": "/id_type", "value": "NOT_ISSUED" }
    ]));
    f.hr.patch_employment_facts(p(), f.employee, id)
        .await
        .unwrap();
    f.hr.record_contract(
        p(),
        f.employee,
        Uuid::new_v4(),
        contract(ContractKind::OpenEnded, "2026-09-01", None),
    )
    .await
    .unwrap();
    let later = f.hr.onboarding_checklist(p(), f.employee).await.unwrap();
    assert_eq!(
        state(&later, ChecklistItem::ContractRecorded),
        ItemState::Done
    );
    assert_eq!(
        state(&later, ChecklistItem::IdRegistered),
        ItemState::FollowUp
    );

    let stranger = Principal::new(
        UserId::new(),
        OrgId::new(),
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    );
    assert_eq!(
        f.hr.employment_facts(stranger, f.employee)
            .await
            .unwrap_err()
            .status,
        404
    );
}
