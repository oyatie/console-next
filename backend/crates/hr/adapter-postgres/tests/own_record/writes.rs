//! regression: people-self-33 — the self rule also covers a contract, the
//! employment facts, a 사번 변경 and a 인사기록카드 entry on one's own record:
//! 403 `own_record_forbidden`, nothing written. Someone else's record is the
//! worker's ordinary work.

use console_hr_adapter_postgres::contract::RecordContractRequest;
use console_hr_adapter_postgres::employee_number::change::EmployeeNumberChangeRequest;
use console_hr_adapter_postgres::record::CreateRecordRequest;
use console_hr_domain::contract::ContractKind;
use console_hr_domain::profile::enums::PayUnit;
use console_hr_domain::record::Section;
use serde_json::json;
use sqlx::PgPool;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use crate::world::{OWN, World, refused, world};

fn contract() -> RecordContractRequest {
    RecordContractRequest {
        kind: ContractKind::FixedTerm,
        start_date: "2026-09-01".into(),
        end_date: Some("2027-02-28".into()),
        wage_won: 2_600_000,
        pay_unit: PayUnit::Monthly,
        weekly_minutes: Some(2400),
        supersedes_id: None,
    }
}

async fn number_change(w: &World, employee: Uuid, number: &str) -> EmployeeNumberChangeRequest {
    let at: OffsetDateTime = sqlx::query_scalar("SELECT updated_at FROM employees WHERE id = $1")
        .bind(employee)
        .fetch_one(&w.owner)
        .await
        .unwrap();
    EmployeeNumberChangeRequest {
        new_number: number.into(),
        effective_date: console_hr_adapter_postgres::clock::today_kst().to_string(),
        reason_code: "NUMBERING_SCHEME_CHANGE".into(),
        note: None,
        expected_updated_at: at.format(&Rfc3339).unwrap(),
    }
}

fn education() -> CreateRecordRequest {
    CreateRecordRequest {
        fields: json!({ "school": "한국고", "level": "BACHELOR", "major": "경영학",
            "status": "GRADUATED", "entered_on": "2010-03-02", "ended_on": "2014-02-20" }),
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_hr_worker_cannot_write_their_own_facts_contract_number_or_record(pool: PgPool) {
    let w = world(pool).await;
    let (worker, own) = w.hr_worker().await;
    let other = w.employee("김직원").await;
    let p = || worker.clone();
    let written = "SELECT (SELECT count(*) FROM employee_contracts WHERE employee_id = $1) \
                   + (SELECT count(*) FROM employee_number_changes WHERE employee_id = $1) \
                   + (SELECT count(*) FROM employee_person_bindings WHERE employee_id = $1)";
    let before = w.count(written, own).await;

    let (status, code, _) = refused(
        w.hr.record_contract(p(), own, Uuid::new_v4(), contract())
            .await,
    );
    assert_eq!((status, code), OWN, "contract");
    let facts = serde_json::from_value(
        json!([{ "op": "replace", "path": "/birth_date", "value": "1994-03-02" }]),
    )
    .unwrap();
    let (status, code, _) = refused(w.hr.patch_employment_facts(p(), own, facts).await);
    assert_eq!((status, code), OWN, "employment facts");
    let change = number_change(&w, own, "HB-9001").await;
    let (status, code, _) = refused(w.hr.change_employee_number(p(), own, change).await);
    assert_eq!((status, code), OWN, "사번 변경");
    let entry =
        w.hr.create_record(p(), own, Section::Education, Uuid::new_v4(), education())
            .await;
    let (status, code, _) = refused(entry);
    assert_eq!((status, code), OWN, "인사기록카드");

    assert_eq!(w.count(written, own).await, before);

    w.hr.record_contract(p(), other, Uuid::new_v4(), contract())
        .await
        .unwrap();
    let change = number_change(&w, other, "HB-9002").await;
    w.hr.change_employee_number(p(), other, change)
        .await
        .unwrap();
    w.hr.create_record(p(), other, Section::Education, Uuid::new_v4(), education())
        .await
        .unwrap();
}
