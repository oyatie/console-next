//! Exit-case row decoding (moved from `app/src/hr.rs`, R2-exits).

use console_hr_domain::exits::next_actions::exit_case_next_actions;

use crate::exits::group_transfer_case::GROUP_TRANSFER_EXIT_REASON;
use serde_json::Value;
use sqlx::Row;
use uuid::Uuid;

use crate::HrError;
use crate::exits::settlement::{
    compute_certified_package_digest, with_certification_status_marker,
};
use crate::exits::types::{EmployeeExitCaseResponse, EmployeeExitSettlementPackageResponse};

pub fn exit_case_from_row(row: sqlx::postgres::PgRow) -> Result<EmployeeExitCaseResponse, HrError> {
    let package_id: Option<Uuid> = row.try_get("package_id")?;
    let settlement_package = if let Some(id) = package_id {
        let service_days: Option<i32> = row.try_get("service_days")?;
        let average_wage_period_start: Option<String> = row.try_get("average_wage_period_start")?;
        let average_wage_period_end: Option<String> = row.try_get("average_wage_period_end")?;
        let average_wage_calendar_days: Option<i32> = row.try_get("average_wage_calendar_days")?;
        let average_wage_total_won: Option<i64> = row.try_get("average_wage_total_won")?;
        let average_daily_wage_milliwon: Option<i64> =
            row.try_get("average_daily_wage_milliwon")?;
        let severance_pay_won: Option<i64> = row.try_get("severance_pay_won")?;
        let monthly_ordinary_wage_won: Option<i64> = row.try_get("monthly_ordinary_wage_won")?;
        let ordinary_daily_wage_won: Option<i64> = row.try_get("ordinary_daily_wage_won")?;
        let statutory_daily_wage_milliwon: Option<i64> =
            row.try_get("statutory_daily_wage_milliwon")?;
        let statutory_basis: Value = row.try_get("statutory_basis")?;
        let insurance_loss_payload: Value = row.try_get("insurance_loss_payload")?;
        let approval_payload: Value = row.try_get("approval_payload")?;
        let stored_certification_status: String = row.try_get("certification_status")?;
        let stored_digest: Option<String> = row.try_get("certified_package_digest")?;

        // Honor CERTIFIED only when the stored digest still binds the CURRENT
        // numbers. A stale digest (numbers recomputed after certification) or a
        // missing digest is reported as UNCERTIFIED_DRAFT — the code, not the DB
        // CHECK, is what proves the artifact certified *these* figures.
        let recomputed_digest = compute_certified_package_digest(
            severance_pay_won,
            &statutory_basis,
            &insurance_loss_payload,
            &approval_payload,
            average_wage_period_start.as_deref(),
            average_wage_period_end.as_deref(),
            average_wage_calendar_days,
            average_wage_total_won,
            average_daily_wage_milliwon,
            service_days,
            monthly_ordinary_wage_won,
            ordinary_daily_wage_won,
            statutory_daily_wage_milliwon,
        );
        let certification_status = if stored_certification_status == "CERTIFIED"
            && stored_digest.as_deref() == Some(recomputed_digest.as_str())
        {
            "CERTIFIED".to_owned()
        } else {
            "UNCERTIFIED_DRAFT".to_owned()
        };

        // 0093 MEDIUM (label plumbing is a backend deliverable): the generated
        // insurance-loss and approval payloads are the documents a human can
        // actually file with MOEL/NHIS, so the EFFECTIVE certification status
        // must ride along inside them too — not just the top-level DTO field —
        // or a surface that only forwards the raw payload could drop the
        // uncertified marker. Mutated AFTER the digest above is computed from
        // the untouched stored values, so this annotation never feeds back
        // into what a certification digest binds.
        let insurance_loss_payload =
            with_certification_status_marker(insurance_loss_payload, &certification_status);
        let approval_payload =
            with_certification_status_marker(approval_payload, &certification_status);

        Some(EmployeeExitSettlementPackageResponse {
            id,
            status: row.try_get("package_status")?,
            service_days,
            average_wage_period_start,
            average_wage_period_end,
            average_wage_calendar_days,
            average_wage_total_won,
            average_daily_wage_milliwon,
            severance_pay_won,
            monthly_ordinary_wage_won,
            ordinary_daily_wage_won,
            statutory_daily_wage_milliwon,
            missing_source_fields: row.try_get("missing_source_fields")?,
            statutory_basis,
            insurance_loss_payload,
            approval_payload,
            certification_status,
            generated_at: row.try_get("generated_at")?,
            submitted_by: row.try_get("submitted_by")?,
            submitted_at: row.try_get("submitted_at")?,
            figures_withheld: false,
        })
    } else {
        None
    };
    let case_id: Uuid = row.try_get("id")?;
    let status: String = row.try_get("status")?;
    let exit_reason_code: Option<String> = row.try_get("exit_reason_code")?;
    let exit_event_state: Option<String> = row.try_get("exit_event_state")?;
    // A 전적 that failed to apply left an ordinary dead case: it closes alone.
    let follows_group_transfer = exit_reason_code.as_deref() == Some(GROUP_TRANSFER_EXIT_REASON)
        && exit_event_state.as_deref() != Some("APPLY_FAILED");
    Ok(EmployeeExitCaseResponse {
        id: case_id,
        employee_id: row.try_get("employee_id")?,
        employee_name: row.try_get("employee_name")?,
        employee_number: row.try_get("employee_number")?,
        company: row.try_get("company")?,
        org_unit: row.try_get("org_unit")?,
        worksite_name: row.try_get("worksite_name")?,
        branch_id: row.try_get("branch_id")?,
        branch_name: row.try_get("branch_name")?,
        absence_alert_id: row.try_get("absence_alert_id")?,
        status: status.clone(),
        effective_exit_date: row.try_get("effective_exit_date")?,
        site_manager_note: row.try_get("site_manager_note")?,
        exit_reason_code,
        reported_by: row.try_get("reported_by")?,
        reported_by_name: row.try_get("reported_by_name")?,
        hr_confirmed_by_name: row.try_get("hr_confirmed_by_name")?,
        hq_confirmed_by_name: row.try_get("hq_confirmed_by_name")?,
        approval_submitted_by_name: row.try_get("approval_submitted_by_name")?,
        closed_by_name: row.try_get("closed_by_name")?,
        reported_at: row.try_get("reported_at")?,
        hr_confirmed_by: row.try_get("hr_confirmed_by")?,
        hr_confirmed_at: row.try_get("hr_confirmed_at")?,
        hq_confirmed_by: row.try_get("hq_confirmed_by")?,
        hq_confirmed_at: row.try_get("hq_confirmed_at")?,
        approval_submitted_by: row.try_get("approval_submitted_by")?,
        approval_submitted_at: row.try_get("approval_submitted_at")?,
        closed_by: row.try_get("closed_by")?,
        closed_at: row.try_get("closed_at")?,
        closed_reason: row.try_get("closed_reason")?,
        settlement_package,
        exit_lifecycle_event_id: row.try_get("exit_lifecycle_event_id")?,
        exit_event_state,
        next_actions: exit_case_next_actions(&status, follows_group_transfer),
        settlement_deadlines: None,
    })
}
