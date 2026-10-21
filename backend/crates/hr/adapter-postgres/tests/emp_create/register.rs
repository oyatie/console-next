//! Registration records the facts of every employment type in one call.

use console_hr_adapter_postgres::directory::create_facts::CreateEmployeeContract;
use console_hr_domain::checklist::{ChecklistItem, ItemState};
use console_hr_domain::contract::ContractKind;
use console_hr_domain::profile::enums::{EmploymentType, IdType, PayUnit};
use console_hr_domain::profile::facts::ProbationState;
use console_hr_domain::profile::registration::contract_kinds;
use sqlx::PgPool;

use crate::fixture::fixture;

fn needs_end(kind: &str) -> bool {
    ContractKind::parse(kind).is_ok_and(ContractKind::requires_end_date)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn every_employment_type_registers_with_its_facts_in_one_call(pool: PgPool) {
    let f = fixture(pool).await;
    for (n, kind) in EmploymentType::ALL.iter().enumerate() {
        let employee_kind = kind.worker_classification().as_str() == "EMPLOYEE";
        let contract_kind = contract_kinds(*kind)[0].as_str();
        let labour = matches!(
            contract_kind,
            "OPEN_ENDED" | "FIXED_TERM" | "PART_TIME" | "DAILY"
        );
        let mut body = f.body(&format!("reg-{n}"), kind.as_str());
        body.work_email = Some(format!(" Person{n}@Corp.CO.KR "));
        body.birth_date = Some("1994-03-02".into());
        body.id_type = Some("RRN".into());
        body.base_pay_won = Some(3_000_000);
        body.pay_unit = Some("MONTHLY".into());
        body.probation_end_date = employee_kind.then(|| "2026-11-30".into());
        body.contract = Some(CreateEmployeeContract {
            kind: contract_kind.into(),
            end_date: needs_end(contract_kind).then(|| "2027-08-31".into()),
            weekly_minutes: labour.then_some(2400),
            ..Default::default()
        });
        let detail = f
            .create(body)
            .await
            .unwrap_or_else(|e| panic!("{kind:?}: {e:?}"));
        let id = detail.employee.id;
        let employment = detail.employment.as_ref().unwrap();
        assert_eq!(employment.employment_type.as_deref(), Some(kind.as_str()));
        assert_eq!(employment.base_pay.as_deref(), Some("3000000.00"));
        if *kind == EmploymentType::Contract {
            assert_eq!(employment.contract_end_date.as_deref(), Some("2027-08-31"));
        }

        let facts =
            f.hr.employment_facts(f.principal.clone(), id)
                .await
                .unwrap();
        assert_eq!(
            facts.work_email.as_deref(),
            Some(format!("Person{n}@corp.co.kr").as_str())
        );
        assert_eq!(facts.birth_date.as_deref(), Some("1994-03-02"));
        assert_eq!(facts.id_type, Some(IdType::Rrn));
        let profile = facts.employment.unwrap();
        assert_eq!(
            (profile.base_pay_won, profile.pay_unit),
            (Some(3_000_000), Some(PayUnit::Monthly))
        );
        assert_eq!(
            profile.worker_classification,
            Some(kind.worker_classification())
        );
        assert_eq!(
            profile.probation_end_date.is_some(),
            employee_kind,
            "{kind:?}: probation only for 근로자"
        );
        if !employee_kind {
            assert_eq!(profile.probation_state, ProbationState::None);
        }

        let contracts =
            f.hr.employee_contracts(f.principal.clone(), id)
                .await
                .unwrap();
        assert_eq!(contracts.items.len(), 1, "{kind:?}");
        assert_eq!(contracts.items[0].kind.as_str(), contract_kind);
        assert_eq!(contracts.items[0].start_date, "2026-09-01");
        assert_eq!(contracts.items[0].wage_won, 3_000_000);

        let checklist =
            f.hr.onboarding_checklist(f.principal.clone(), id)
                .await
                .unwrap();
        for item in [
            ChecklistItem::ContractRecorded,
            ChecklistItem::IdRegistered,
            ChecklistItem::BirthDateRecorded,
            ChecklistItem::PayRecorded,
        ] {
            let state = checklist
                .items
                .iter()
                .find(|e| e.item == item)
                .unwrap()
                .state;
            assert_eq!(state, ItemState::Done, "{kind:?} {item:?}");
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_registration_without_facts_is_unchanged_and_facts_join_the_idempotency_hash(
    pool: PgPool,
) {
    let f = fixture(pool).await;
    let mut legacy = f.body("legacy", "REGULAR");
    legacy.base_pay = "2500000".into();
    let detail = f.create(legacy).await.unwrap();
    let facts =
        f.hr.employment_facts(f.principal.clone(), detail.employee.id)
            .await
            .unwrap();
    assert_eq!(
        (facts.birth_date, facts.work_email, facts.id_type),
        (None, None, None)
    );
    let profile = facts.employment.unwrap();
    assert_eq!((profile.base_pay_won, profile.pay_unit), (None, None));
    let contracts =
        f.hr.employee_contracts(f.principal.clone(), detail.employee.id)
            .await
            .unwrap();
    assert!(contracts.items.is_empty());

    // Same key, other facts: the stored hash covers the facts → 409.
    let mut first = f.body("hashed", "REGULAR");
    first.base_pay_won = Some(2_500_000);
    first.pay_unit = Some("MONTHLY".into());
    f.create(first).await.unwrap();
    let mut second = f.body("hashed", "REGULAR");
    second.base_pay_won = Some(2_600_000);
    second.pay_unit = Some("MONTHLY".into());
    assert_eq!(f.create(second).await.unwrap_err().status, 409);
}
