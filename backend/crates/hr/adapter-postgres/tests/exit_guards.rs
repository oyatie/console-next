// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Legal exit refusals run through the real runtime-role service.
mod support;
use console_hr_adapter_postgres::{HrError, exits::types::ReportEmployeeExitCaseRequest};
use console_kernel_core::OrgId;
use console_settings_adapter_postgres::validate_reason_in_tx;
use console_settings_domain::code_lists::ReasonDomain;
use serde_json::{Value, json};
use sqlx::PgPool;
use support::{World, world};
use time::{Duration, macros::date};
use uuid::Uuid;

async fn live(pool: &PgPool) -> World {
    let w = world(pool).await;
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(w.org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE tenant_phase SET phase = 'OPERATING'")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE employees SET employment_status = 'ACTIVE' WHERE org_id = $1")
        .bind(w.org)
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    w
}
fn acks() -> Value {
    json!({"privacy_notice_ack":true,"korean_labor_law_ack":true,"payroll_cutoff_ack":true,"retirement_settlement_ack":true})
}
fn notice(served: &str) -> Value {
    json!({"reason_text":"서면 사유","served_on":served,"method":"CERTIFIED_MAIL","evidence_ref":"synthetic-receipt"})
}
async fn report(
    w: &World,
    employee: Uuid,
    reason: Option<&str>,
    on: &str,
) -> Result<Value, HrError> {
    let body: ReportEmployeeExitCaseRequest = serde_json::from_value(json!({"employee_id":employee,"effective_exit_date":on,"site_manager_note":"퇴직 경위","exit_reason_code":reason})).unwrap();
    w.hr.report_exit_case(w.hr(w.hr_one), Uuid::new_v4().to_string(), body)
        .await
        .map(|(_, v)| v)
}
async fn confirm(w: &World, case: &Value, extra: Value) -> Result<Value, HrError> {
    let mut body = json!({"signoffs":acks()});
    body.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    w.hr.confirm_exit_case(
        w.hr(w.hr_one),
        None,
        case["id"].as_str().unwrap().parse().unwrap(),
        serde_json::from_value(body).unwrap(),
    )
    .await
    .map(|v| serde_json::to_value(v).unwrap())
}
async fn leave(w: &World, employee: Uuid, kind: &str, on: &str, until: Option<&str>) -> Value {
    w.hr.record_lifecycle_event(w.hr(w.hr_one), employee, Uuid::new_v4().to_string(), serde_json::from_value(json!({"event_type":"LEAVE_OF_ABSENCE","effective_date":on,"leave_type":kind,"expected_return_date":until,"comment":"합성 휴직","signoffs":acks()})).unwrap()).await.unwrap()
}
async fn count(pool: &PgPool, table: &str, w: &World) -> i64 {
    sqlx::query_scalar(match table {
        "employee_exit_cases" => "SELECT count(*) FROM employee_exit_cases WHERE org_id=$1",
        "employee_lifecycle_events" => {
            "SELECT count(*) FROM employee_lifecycle_events WHERE org_id=$1"
        }
        _ => panic!("unknown count fixture"),
    })
    .bind(w.org)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[path = "exit_guards/access.rs"]
mod access;
#[path = "exit_guards/boundaries.rs"]
mod boundaries;
#[path = "exit_guards/confirm.rs"]
mod confirm_tests;
#[path = "exit_guards/hooks.rs"]
mod hook_tests;
#[path = "exit_guards/report.rs"]
mod report_tests;
#[path = "exit_guards/scheduled.rs"]
mod scheduled_tests;
