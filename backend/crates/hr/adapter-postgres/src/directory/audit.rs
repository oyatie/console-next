//! The `employee.create` audit event (moved from `app/src/hr.rs`, R2-people).

use console_kernel_core::{AuditAction, AuditEvent, BranchId, OrgId, TraceContext, UserId};
use serde_json::json;
use time::OffsetDateTime;

use crate::HrError;
use crate::directory::types::{EmployeeDetailResponse, NormalizedCreateEmployeeRequest};

/// The `employee.create` audit event that accompanies a non-replayed
/// [`create_employee_core`] call, identical for both write paths.
pub fn employee_create_audit(
    org: OrgId,
    actor: UserId,
    request: &NormalizedCreateEmployeeRequest,
    created: &EmployeeDetailResponse,
) -> Result<AuditEvent, HrError> {
    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new("employee.create").map_err(HrError::from_kernel)?,
        "employee",
        created.employee.id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(
        None,
        Some(json!({
            "employee_number": &created.employee.employee_number,
            "employee_number_assigned": request.employee_number.is_empty(),
            "employment_type": &request.employment_type,
            "requested_home_branch_id": request.home_branch_id,
            "compensation_recorded": request.base_pay.is_some(),
            "phone_recorded": request.phone_e164.is_some(),
            // EMP-CREATE: which facts were recorded, never their values.
            "person_facts_recorded": request.facts.birth_date.is_some()
                || request.facts.work_email.is_some()
                || request.facts.id_type.is_some(),
            "pay_unit_recorded": request.facts.pay_unit.is_some(),
            "probation_recorded": request.facts.probation_end_date.is_some(),
            "contract_kind": request.facts.contract.as_ref().map(|c| c.kind.as_str())
        })),
    );
    Ok(match request.home_branch_id {
        Some(branch) => event.with_branch(BranchId::from_uuid(branch)),
        None => event,
    })
}
