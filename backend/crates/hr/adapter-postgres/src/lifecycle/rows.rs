//! The lifecycle event projection and its row decoder.

use console_hr_domain::lifecycle::group_transfer::Continuity;
use console_hr_domain::lifecycle::signoffs::EmployeeLifecycleSignoffs;
use serde_json::Value;
use sqlx::Row;

use super::classification::columns_from_row;
use super::types::{EmployeeLifecycleEventResponse, GroupTransferView};
use crate::HrError;

/// Every lifecycle-event read goes through this projection so the recorder's
/// display name (tenant-scoped `users`, null when unknown) is always present.
/// A macro so the full statement stays a literal.
#[macro_export]
macro_rules! lifecycle_event_select {
    ($tail:literal) => {
        concat!(
            "SELECT l.id, l.employee_id, l.event_type, l.from_status, l.to_status, \
             l.from_company, l.to_company, l.from_org_unit, l.to_org_unit, \
             l.from_position, l.to_position, l.effective_date, l.comment, \
             l.signoffs, l.created_by, u.display_name AS created_by_name, l.created_at, \
             (SELECT e.actor_kind FROM audit_events e WHERE e.org_id=l.org_id AND e.actor=l.created_by AND e.created_at=l.created_at AND e.target_type='employee' AND e.target_id=l.employee_id::text AND e.outcome='ALLOWED' ORDER BY e.id DESC LIMIT 1) AS actor_kind, \
             (SELECT e.command_id FROM audit_events e WHERE e.org_id=l.org_id AND e.actor=l.created_by AND e.created_at=l.created_at AND e.target_type='employee' AND e.target_id=l.employee_id::text AND e.outcome='ALLOWED' ORDER BY e.id DESC LIMIT 1) AS command_id, \
             l.expected_return_date::TEXT AS expected_return_date, \
             l.contract_end_date::TEXT AS contract_end_date, \
             l.leave_type, l.batch_id, l.state, l.applied_at, l.failure_code, \
             l.failure_reason, l.cancelled_by, l.cancelled_at, l.cancel_reason, \
             l.superseded_by, cu.display_name AS cancelled_by_name, \
             l.reason_code, l.from_job_title_id, l.to_job_title_id, l.voids_event_id, \
             l.to_workplace_id, g.from_legal_entity_id AS gt_from, \
             l.from_grade_id, l.to_grade_id, l.from_position_kind_id, l.to_position_kind_id, \
             l.from_job_id, l.to_job_id, l.from_job_family_id, l.to_job_family_id, \
             l.from_job, l.to_job, l.from_employment_type, l.to_employment_type, \
             l.from_contract_start_date, \
             g.to_legal_entity_id AS gt_to, g.continuity AS gt_continuity, \
             g.annual_leave_continuity AS gt_annual_leave, g.seniority_continuity AS gt_seniority, \
             (SELECT c.id FROM employee_exit_cases c WHERE g.lifecycle_event_id IS NOT NULL \
                AND c.org_id = l.org_id AND c.exit_lifecycle_event_id = l.id) AS gt_case, \
             g.group_service_start_date::TEXT AS gt_service_start, \
             g.consent_date::TEXT AS gt_consent_date, g.consent_evidence_ref AS gt_consent_ref, \
             g.succession_evidence_ref AS gt_succession_ref, \
             (SELECT v.id FROM employee_lifecycle_events v WHERE v.voids_event_id = l.id) AS voided_by \
             FROM employee_lifecycle_events l \
             LEFT JOIN person_accounts_current u ON u.id = l.created_by \
             LEFT JOIN person_accounts_current cu ON cu.id = l.cancelled_by \
             LEFT JOIN employee_group_transfers g \
               ON g.org_id = l.org_id AND g.lifecycle_event_id = l.id ",
            $tail
        )
    };
}

fn group_transfer_view(row: &sqlx::postgres::PgRow) -> Result<Option<GroupTransferView>, HrError> {
    let continuity: Option<String> = row.try_get("gt_continuity")?;
    let Some(continuity) = continuity else {
        return Ok(None);
    };
    // A row the release before 0356 wrote (blue/green overlap, or after a
    // rollback) has no 연차/근속 pair: it recorded the one-choice contract,
    // which Continuity::parse reads exactly as the 0356 backfill does.
    let annual_leave: Option<String> = row.try_get("gt_annual_leave")?;
    let seniority: Option<String> = row.try_get("gt_seniority")?;
    let read = Continuity::parse(
        Some(&continuity),
        annual_leave.as_deref(),
        seniority.as_deref(),
    )
    .map_err(HrError::from_kernel)?;
    Ok(Some(GroupTransferView {
        from_legal_entity_id: row.try_get("gt_from")?,
        to_legal_entity_id: row.try_get("gt_to")?,
        continuity,
        annual_leave_continuity: read.annual_leave.as_str().to_owned(),
        seniority_continuity: read.seniority.as_str().to_owned(),
        settlement_case_id: row.try_get("gt_case")?,
        group_service_start_date: row.try_get("gt_service_start")?,
        consent_date: row.try_get("gt_consent_date")?,
        consent_evidence_ref: row.try_get("gt_consent_ref")?,
        succession_evidence_ref: row.try_get("gt_succession_ref")?,
    }))
}

pub fn employee_lifecycle_event_from_row(
    row: sqlx::postgres::PgRow,
) -> Result<EmployeeLifecycleEventResponse, HrError> {
    let signoffs: Value = row.try_get("signoffs")?;
    let signoffs = serde_json::from_value::<EmployeeLifecycleSignoffs>(signoffs)
        .map_err(|err| HrError::validation(format!("invalid lifecycle signoffs: {err}")))?;
    Ok(EmployeeLifecycleEventResponse {
        id: row.try_get("id")?,
        employee_id: row.try_get("employee_id")?,
        event_type: row.try_get("event_type")?,
        from_status: row.try_get("from_status")?,
        to_status: row.try_get("to_status")?,
        from_company: row.try_get("from_company")?,
        to_company: row.try_get("to_company")?,
        from_org_unit: row.try_get("from_org_unit")?,
        to_org_unit: row.try_get("to_org_unit")?,
        from_position: row.try_get("from_position")?,
        to_position: row.try_get("to_position")?,
        expected_return_date: row.try_get("expected_return_date")?,
        contract_end_date: row.try_get("contract_end_date")?,
        leave_type: row.try_get("leave_type")?,
        batch_id: row.try_get("batch_id")?,
        state: row.try_get("state")?,
        applied_at: row.try_get("applied_at")?,
        failure_code: row.try_get("failure_code")?,
        failure_reason: row.try_get("failure_reason")?,
        cancelled_by: row.try_get("cancelled_by")?,
        cancelled_by_name: row.try_get("cancelled_by_name")?,
        cancelled_at: row.try_get("cancelled_at")?,
        cancel_reason: row.try_get("cancel_reason")?,
        superseded_by: row.try_get("superseded_by")?,
        reason_code: row.try_get("reason_code")?,
        from_job_title_id: row.try_get("from_job_title_id")?,
        to_job_title_id: row.try_get("to_job_title_id")?,
        voids_event_id: row.try_get("voids_event_id")?,
        voided_by: row.try_get("voided_by")?,
        to_workplace_id: row.try_get("to_workplace_id")?,
        group_transfer: group_transfer_view(&row)?,
        classification: columns_from_row(&row)?,
        effective_date: row.try_get("effective_date")?,
        // 0252 made comment nullable (reason_code-only rows); every
        // writer still requires a comment, so the wire keeps a string until a
        // code-only reason is admitted.
        comment: Option::unwrap_or_default(row.try_get("comment")?),
        signoffs,
        created_by: row.try_get("created_by")?,
        created_by_name: row.try_get("created_by_name")?,
        actor_kind: row.try_get("actor_kind")?,
        command_id: row.try_get("command_id")?,
        created_at: row.try_get("created_at")?,
    })
}
