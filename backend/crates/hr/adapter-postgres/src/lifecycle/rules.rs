//! The lifecycle gate: acknowledgements, state rule and no-op rule. Kept in
//! the adapter while the refusals carry HrError-only codes.

use console_hr_domain::lifecycle::classification::classification_noop;
use console_hr_domain::lifecycle::event::{
    EmployeeForLifecycle, NormalizedEmployeeLifecycleTransition,
};
use console_hr_domain::lifecycle::signoffs::{required_lifecycle_signoffs, signoff_held};
use console_hr_domain::text::{normalize_enum_text, parse_yyyy_mm_dd};
use console_kernel_core::KernelError;

use super::classification::profile_missing;
use super::title_reason::coded;
use crate::HrError;

pub fn require_signoffs(
    transition: &NormalizedEmployeeLifecycleTransition,
    required: &[&str],
) -> Result<(), HrError> {
    match required
        .iter()
        .find(|ack| !signoff_held(&transition.signoffs, ack))
    {
        Some(ack) => Err(HrError::signoff_required(ack, &transition.event_type)),
        None => Ok(()),
    }
}

pub fn lifecycle_refusal(message: &'static str) -> HrError {
    HrError::from_kernel(KernelError::invalid_transition(message))
}

/// Full gate for one lifecycle event: base acks, the state rule, the no-op
/// rule, then the event's own acks.
pub fn validate_lifecycle_transition(
    current: &EmployeeForLifecycle,
    transition: &NormalizedEmployeeLifecycleTransition,
) -> Result<(), HrError> {
    require_signoffs(transition, required_lifecycle_signoffs("", false))?;
    let current_status = normalize_enum_text(current.employment_status.clone());
    lifecycle_state_rule(
        &current_status,
        current.employment_type.as_deref(),
        &transition.event_type,
        &transition.to_status,
    )?;
    let cross_company = transition
        .to_company
        .as_ref()
        .is_some_and(|next| next != &current.company);
    // E-S3b: the company is the 법인; changing it is a 전적, never a TRANSFER.
    if transition.event_type == "TRANSFER" && cross_company {
        return Err(coded(
            KernelError::conflict(
                "moving to another 법인 is a 전적 (exit and re-hire), not a transfer",
            )
            .with_code("entity_change_needs_group_transfer"),
        ));
    }
    reject_lifecycle_noop(current, transition, cross_company)?;
    if let (Some(start), Some(end)) = (current.contract_start_date, &transition.contract_end_date)
        && parse_yyyy_mm_dd(end)? < start
    {
        return Err(HrError::validation(
            "contract_end_date must be on or after contract_start_date",
        ));
    }
    require_signoffs(
        transition,
        required_lifecycle_signoffs(&transition.event_type, cross_company),
    )
}

/// State rules: no event on an EXITED employee; LEAVE_OF_ABSENCE only from
/// ACTIVE; RETURN_FROM_LEAVE only from ON_LEAVE; TRANSFER/PROMOTE/ONBOARD not
/// while ON_LEAVE (return first); OFFBOARD/TERMINATE allowed from ON_LEAVE;
/// CONTRACT_RENEWAL keeps the current status and needs a CONTRACT employment;
/// APPOINT and a 전환 keep it too (a 전환 needs the employment profile).
pub fn lifecycle_state_rule(
    current_status: &str,
    employment_type: Option<&str>,
    event: &str,
    to: &str,
) -> Result<(), HrError> {
    if current_status == "EXITED" {
        return Err(lifecycle_refusal(
            "employee is already EXITED; no lifecycle events are allowed",
        ));
    }
    match event {
        "ONBOARD" | "TRANSFER" | "GROUP_TRANSFER" | "PROMOTE" if current_status == "ON_LEAVE" => {
            return Err(lifecycle_refusal(
                "employee is ON_LEAVE; record RETURN_FROM_LEAVE first",
            ));
        }
        "ONBOARD" if to != "ACTIVE" => {
            return Err(lifecycle_refusal("ONBOARD must result in ACTIVE status"));
        }
        "OFFBOARD" | "TERMINATE" if to != "EXITED" => {
            return Err(lifecycle_refusal(
                "OFFBOARD and TERMINATE must result in EXITED status",
            ));
        }
        "TRANSFER" | "GROUP_TRANSFER" if to != "ACTIVE" => {
            return Err(lifecycle_refusal("TRANSFER must keep the employee ACTIVE"));
        }
        "PROMOTE" if to != "ACTIVE" => {
            return Err(lifecycle_refusal("PROMOTE must keep the employee ACTIVE"));
        }
        "LEAVE_OF_ABSENCE" if current_status != "ACTIVE" => {
            return Err(lifecycle_refusal(
                "LEAVE_OF_ABSENCE requires an ACTIVE employee",
            ));
        }
        "LEAVE_OF_ABSENCE" if to != "ON_LEAVE" => {
            return Err(lifecycle_refusal(
                "LEAVE_OF_ABSENCE must result in ON_LEAVE status",
            ));
        }
        "RETURN_FROM_LEAVE" if current_status != "ON_LEAVE" => {
            return Err(lifecycle_refusal(
                "RETURN_FROM_LEAVE requires an ON_LEAVE employee",
            ));
        }
        "RETURN_FROM_LEAVE" if to != "ACTIVE" => {
            return Err(lifecycle_refusal(
                "RETURN_FROM_LEAVE must result in ACTIVE status",
            ));
        }
        "CONTRACT_RENEWAL" if employment_type != Some("CONTRACT") => {
            return Err(lifecycle_refusal(
                "CONTRACT_RENEWAL requires a CONTRACT employment",
            ));
        }
        "CONTRACT_RENEWAL" if to != current_status => {
            return Err(lifecycle_refusal(
                "CONTRACT_RENEWAL must keep the current status",
            ));
        }
        // MR-24: a 전환 rewrites the employment profile, which an imported
        // person may not have yet.
        "EMPLOYMENT_TYPE_CHANGE" if employment_type.is_none() => return Err(profile_missing()),
        "APPOINT" | "EMPLOYMENT_TYPE_CHANGE" if to != current_status => {
            return Err(lifecycle_refusal(
                "APPOINT and EMPLOYMENT_TYPE_CHANGE keep the current status",
            ));
        }
        _ => {}
    }
    Ok(())
}

/// 422 `lifecycle_noop`: a TRANSFER that changes neither company nor unit, a
/// PROMOTE to the 직위 and 직급 the employee already holds, an APPOINT that
/// changes nothing, or a 전환 to the current 고용형태.
pub fn reject_lifecycle_noop(
    current: &EmployeeForLifecycle,
    transition: &NormalizedEmployeeLifecycleTransition,
    cross_company: bool,
) -> Result<(), HrError> {
    let noop = match transition.event_type.as_str() {
        "TRANSFER" if !cross_company => {
            // A named 사업장 is checked against the assignment when the
            // target resolves (E-S3b).
            transition.to_workplace_id.is_none()
                && match (transition.to_org_unit_id, &transition.to_org_unit) {
                    (Some(unit), _) => current.org_unit_id == Some(unit),
                    (None, Some(text)) => current.org_unit.as_deref() == Some(text.as_str()),
                    (None, None) => true,
                }
        }
        // MR-25: a PROMOTE reads its 직위 and 직급; APPOINT and 전환 their own.
        _ => classification_noop(current, transition).unwrap_or(false),
    };
    if noop {
        return Err(HrError::lifecycle_noop(&transition.event_type));
    }
    Ok(())
}
