//! Statutory-basis, insurance-loss and approval payloads (moved from
//! `app/src/hr.rs`, R2-exits).

use console_hr_domain::exits::case::ExitCaseContext;
use console_payroll_domain::{moel_retirement_pay_source, nhis_qualification_loss_form_source};
use serde_json::{Value, json};

pub fn exit_statutory_basis() -> Value {
    json!({
        "retirement_pay": {
            "authority": moel_retirement_pay_source().authority,
            "title": moel_retirement_pay_source().title,
            "url": moel_retirement_pay_source().url,
            "retrieved_on": moel_retirement_pay_source().retrieved_on.to_string(),
            "formula": "average_daily_wage * 30 * service_days / 365"
        },
        "insurance_loss": {
            "authority": nhis_qualification_loss_form_source().authority,
            "title": nhis_qualification_loss_form_source().title,
            "url": nhis_qualification_loss_form_source().url,
            "retrieved_on": nhis_qualification_loss_form_source().retrieved_on.to_string()
        }
    })
}

pub fn build_insurance_loss_payload(context: &ExitCaseContext) -> Value {
    json!({
        "employee": {
            "id": context.employee_id,
            "name": context.employee_name,
            "employee_number": context.employee_number,
            "company": context.company,
            "org_unit": context.org_unit,
            "position": context.position,
            "worksite_name": context.worksite_name
        },
        "exit": {
            "case_id": context.id,
            "effective_exit_date": context.effective_exit_date,
            "reported_reason": context.site_manager_note
        },
        "forms": [
            "national_pension_workplace_subscriber_loss",
            "health_insurance_workplace_subscriber_loss",
            "employment_insurance_insured_loss",
            "workers_compensation_insured_loss"
        ],
        "source_url": nhis_qualification_loss_form_source().url
    })
}

pub fn build_exit_approval_payload(context: &ExitCaseContext, note: Option<&str>) -> Value {
    json!({
        "document_type": "employee_exit_settlement",
        "title": format!("{} 퇴사 정산 및 4대보험 상실신고", context.employee_name),
        "target_date": context.effective_exit_date,
        "employee_id": context.employee_id,
        "company": context.company,
        "org_unit": context.org_unit,
        "branch_id": context.branch_id,
        "branch_name": context.branch_name,
        "requested_note": note,
        "approval_line": [
            "site_manager",
            "employee_hr_manager",
            "hq_hr_manager",
            "payroll_manager",
            "insurance_loss_reporter"
        ],
        "tracking": {
            "payroll_cutoff": true,
            "insurance_loss_report": true,
            "retirement_settlement": true
        },
        "href": format!("/approvals?source=employee-exit&focus={}", context.id)
    })
}
