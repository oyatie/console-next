use console_hr_adapter_postgres::HrError;
use console_hr_adapter_postgres::exits::types::ReportEmployeeExitCaseRequest;
use console_kernel_core::BranchScope;
use console_platform_authz::{Principal, Role};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{Fixture, fixture, status};

async fn report(
    f: &Fixture,
    who: &Principal,
    employee: Uuid,
    date: &str,
) -> Result<Value, HrError> {
    let body: ReportEmployeeExitCaseRequest = serde_json::from_value(json!({
        "employee_id": employee, "effective_exit_date": date,
        "site_manager_note": "본인 사정", "exit_reason_code": "PERSONAL",
    }))
    .unwrap();
    f.hr.report_exit_case(who.clone(), Uuid::new_v4().to_string(), body)
        .await
        .map(|(_, case)| case)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_exit_report_refuses_and_writes_nothing(pool: PgPool) {
    let f = fixture(pool, true).await;
    let e = f.employee().await;
    // A 퇴직일 before the 입사일 (2025-01-02).
    let early = report(&f, &f.ops, e, "2024-12-31").await.unwrap_err();
    assert_eq!(status(&early), (422, "effective_date_before_hire"));
    assert_eq!(f.count("employee_exit_cases").await, 0);
    assert_eq!(f.audits("employee.exit.report").await, 0);
    // No permission to report: 403, nothing written.
    let member = f.other(&[Role::Member], BranchScope::All).await;
    let denied = report(&f, &member, e, "2026-10-31").await.unwrap_err();
    assert_eq!(denied.status.as_u16(), 403);
    assert_eq!(f.count("employee_exit_cases").await, 0);
    // One open case at a time.
    report(&f, &f.ops, e, "2026-10-31").await.unwrap();
    let twice = report(&f, &f.ops, e, "2026-11-30").await.unwrap_err();
    assert_eq!(status(&twice), (409, "exit_case_open"));
    assert_eq!(f.count("employee_exit_cases").await, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn after_go_live_a_fresh_registration_is_cancelled_and_a_worked_one_exits(pool: PgPool) {
    let f = fixture(pool, true).await;
    let e = f.employee().await;
    let o = f.hr.employee_end_options(&f.ops, e).await.unwrap();
    assert_eq!((o.phase, o.cancel_route), ("OPERATING", "VOID"));
    assert!(o.cancel.allowed && o.attestation_required && o.exit.allowed);
    assert!(o.can_cancel && o.can_report_exit);
    // An exit case is a work record: 등록 취소 is refused, 퇴직 continues.
    let case = report(&f, &f.ops, e, "2026-10-31").await.unwrap();
    let o = f.hr.employee_end_options(&f.ops, e).await.unwrap();
    assert_eq!(o.cancel.refusal, Some("employee_void_has_work_records"));
    assert_eq!(o.exit.refusal, Some("exit_case_open"));
    assert_eq!(o.open_exit_case_id, Some(crate::uuid(&case["id"])));
    // Once exited, 퇴직 is not offered again.
    sqlx::query("UPDATE employees SET employment_status = 'EXITED' WHERE id = $1")
        .bind(e)
        .execute(&f.owner)
        .await
        .unwrap();
    sqlx::query("UPDATE employee_exit_cases SET status = 'CANCELLED' WHERE employee_id = $1")
        .bind(e)
        .execute(&f.owner)
        .await
        .unwrap();
    let o = f.hr.employee_end_options(&f.ops, e).await.unwrap();
    assert_eq!(o.exit.refusal, Some("employee_already_exited"));
    // A reader without the directory: 403.
    let member = f.other(&[Role::Member], BranchScope::All).await;
    let denied = f.hr.employee_end_options(&member, e).await.unwrap_err();
    assert_eq!(denied.status.as_u16(), 403);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn during_setup_the_cancel_is_the_setup_delete(pool: PgPool) {
    let f = fixture(pool, false).await;
    let e = f.employee().await;
    let o = f.hr.employee_end_options(&f.ops, e).await.unwrap();
    assert_eq!((o.phase, o.cancel_route), ("SETUP", "DELETE"));
    assert!(o.cancel.allowed && !o.attestation_required && !o.register_confirmation_required);
}
