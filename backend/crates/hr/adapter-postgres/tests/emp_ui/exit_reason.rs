//! 퇴직 사유 at the exit report (EMP-UI 14) and the dead end it closes.

use console_hr_adapter_postgres::HrError;
use console_hr_adapter_postgres::corrections::{CorrectEmployeeRequest, SecondPersonContext};
use console_hr_adapter_postgres::exits::types::ReportEmployeeExitCaseRequest;
use console_platform_test_support::soft_passkey::passkey_service;
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use crate::{Fixture, fixture, status};

const SECOND: SecondPersonContext = SecondPersonContext {
    other_eligible_holders: 1,
    routed: true,
    sole_holder_refuse: false,
};

async fn report(f: &Fixture, employee: Uuid, code: Option<&str>) -> Result<Value, HrError> {
    let body: ReportEmployeeExitCaseRequest = serde_json::from_value(json!({
        "employee_id": employee, "effective_exit_date": "2026-10-31",
        "site_manager_note": "본인 사정으로 퇴사 의사", "exit_reason_code": code,
    }))
    .unwrap();
    let key = Uuid::new_v4().to_string();
    f.hr.report_exit_case(f.ops.clone(), key, body)
        .await
        .map(|(_, case)| case)
}

/// The employee as EXITED outside the case flow (the case stays live), the
/// state a confirmed exit leaves the register in.
async fn exited(f: &Fixture, employee: Uuid) {
    sqlx::query("UPDATE employees SET employment_status = 'EXITED' WHERE id = $1")
        .bind(employee)
        .execute(&f.owner)
        .await
        .unwrap();
}

async fn record_reason(f: &Fixture, employee: Uuid, code: &str) -> Result<(), HrError> {
    let at: OffsetDateTime = sqlx::query_scalar("SELECT updated_at FROM employees WHERE id = $1")
        .bind(employee)
        .fetch_one(&f.owner)
        .await
        .unwrap();
    let body: CorrectEmployeeRequest = serde_json::from_value(json!({
        "expected_updated_at": at.format(&Rfc3339).unwrap(),
        "changes": { "exit_reason": code }, "reason_code": "DATA_ENTRY_ERROR",
    }))
    .unwrap();
    f.hr.correct_employee(f.ops.clone(), &passkey_service(), employee, body, SECOND)
        .await
        .map(|_| ())
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_report_takes_a_catalog_reason_and_it_is_the_employees(pool: PgPool) {
    let f = fixture(pool, true).await;
    let e = f.employee().await;
    let case = report(&f, e, Some("PERSONAL")).await.unwrap();
    assert_eq!(case["exit_reason_code"], "PERSONAL");
    let register = console_compliance_adapter_postgres::PgComplianceStore::new(f.owner.clone())
        .statutory_register()
        .await
        .unwrap();
    let read =
        f.hr.exit_case(f.ops.clone(), crate::uuid(&case["id"]), &register)
            .await
            .unwrap();
    assert_eq!(read.exit_reason_code.as_deref(), Some("PERSONAL"));
    // The case read serves its settlement deadlines from the register: 「근로기준법」
    // 제36조 and 「근로자퇴직급여 보장법」 제9조, open from the 퇴직일.
    let deadlines = read.settlement_deadlines.unwrap();
    let due: Vec<_> = deadlines
        .iter()
        .map(|d| (d.kind, d.opens_on.as_deref(), d.due_date.as_deref()))
        .collect();
    assert_eq!(
        due,
        [
            ("FINAL_PAY", Some("2026-11-01"), Some("2026-11-14")),
            ("SEVERANCE_PAY", Some("2026-11-01"), Some("2026-11-14"))
        ]
    );
    assert_eq!(deadlines[0].instrument.as_deref(), Some("근로기준법"));
    assert_eq!(deadlines[0].article.as_deref(), Some("제36조"));
    assert_eq!(
        deadlines[1].instrument.as_deref(),
        Some("근로자퇴직급여 보장법")
    );
    assert_eq!(deadlines[1].article.as_deref(), Some("제9조제1항"));
    // The 인사기록카드 register shows the case's 사유.
    let facts = f.hr.register_facts(f.ops.clone(), e).await.unwrap();
    assert_eq!(facts.exit_reason_code.as_deref(), Some("PERSONAL"));
    assert_eq!(facts.exit_reason_label.as_deref(), Some("개인 사정"));
    // The case owns it: a register write is still refused, nothing changes.
    exited(&f, e).await;
    let owned = record_reason(&f, e, "CONTRACT_END").await.unwrap_err();
    assert_eq!(status(&owned), (409, "exit_case_owns_exit_reason"));
    let facts = f.hr.register_facts(f.ops.clone(), e).await.unwrap();
    assert_eq!(facts.exit_reason_code.as_deref(), Some("PERSONAL"));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_unknown_or_retired_reason_refuses_the_report_and_writes_nothing(pool: PgPool) {
    let f = fixture(pool, true).await;
    let e = f.employee().await;
    let retired = format!(
        "T_{}",
        Uuid::new_v4().simple().to_string().to_ascii_uppercase()
    );
    sqlx::query(
        "INSERT INTO reason_codes (org_id, domain, code, label_ko, requires_note, active, created_by) \
         VALUES ($1, 'exit_reason', $2, '옛 사유', false, false, $3)",
    )
    .bind(f.org)
    .bind(&retired)
    .bind(f.user)
    .execute(&f.owner)
    .await
    .unwrap();
    for code in [
        "FIRED",
        "lifecycle_cancel",
        retired.as_str(),
        "T_00000000000000000000000000000000",
    ] {
        let refused = report(&f, e, Some(code)).await.unwrap_err();
        assert_eq!(status(&refused), (422, "reason_code_invalid"), "{code}");
    }
    assert_eq!(f.count("employee_exit_cases").await, 0);
    assert_eq!(f.audits("employee.exit.report").await, 0);
    // The same report without a code still goes in (the 사유 is optional).
    report(&f, e, None).await.unwrap();
    assert_eq!(f.audits("employee.exit.report").await, 1);
}

/// Regression (BE-EMP-UI, EMP-UI 14): on 3c988fc2 any live case owned the
/// 퇴직 사유 though no case could hold one, so after an exit reported through
/// a case the reason could never be recorded (409 exit_case_owns_exit_reason).
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_a_case_without_a_reason_lets_the_register_record_it(pool: PgPool) {
    let f = fixture(pool, true).await;
    let e = f.employee().await;
    report(&f, e, None).await.unwrap();
    exited(&f, e).await;
    record_reason(&f, e, "CONTRACT_END").await.unwrap();
    let facts = f.hr.register_facts(f.ops.clone(), e).await.unwrap();
    assert_eq!(facts.exit_reason_code.as_deref(), Some("CONTRACT_END"));
}
