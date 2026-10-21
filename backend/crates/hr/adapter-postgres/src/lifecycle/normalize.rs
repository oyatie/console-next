//! Lifecycle request normalisation (moved from `app/src/hr.rs`, R2-life).

use console_hr_domain::lifecycle::classification::normalize_classification_change;
use console_hr_domain::lifecycle::event::NormalizedEmployeeLifecycleTransition;
use console_hr_domain::lifecycle::leave_facts::{LEAVE_TYPES, check_leave_facts};
use console_hr_domain::lifecycle::transition::default_lifecycle_status;
use console_hr_domain::text::{
    normalize_enum_text, normalize_limited_text, normalize_optional_text, parse_yyyy_mm_dd,
};

use super::requests::CreateEmployeeLifecycleEventRequest;
use super::title_reason::coded;
use crate::HrError;

const LIFECYCLE_EVENT_TYPES: [&str; 11] = [
    "ONBOARD",
    "OFFBOARD",
    "TERMINATE",
    "TRANSFER",
    "GROUP_TRANSFER",
    "PROMOTE",
    "LEAVE_OF_ABSENCE",
    "RETURN_FROM_LEAVE",
    "CONTRACT_RENEWAL",
    "APPOINT",
    "EMPLOYMENT_TYPE_CHANGE",
];

pub fn normalize_lifecycle_transition(
    body: CreateEmployeeLifecycleEventRequest,
) -> Result<NormalizedEmployeeLifecycleTransition, HrError> {
    let event_type = normalize_enum_text(body.event_type);
    if !LIFECYCLE_EVENT_TYPES.contains(&event_type.as_str()) {
        return Err(HrError::validation(
            "event_type must be ONBOARD, TRANSFER, GROUP_TRANSFER, PROMOTE, APPOINT, LEAVE_OF_ABSENCE, RETURN_FROM_LEAVE, CONTRACT_RENEWAL, or EMPLOYMENT_TYPE_CHANGE",
        ));
    }
    // One coherent exit rule: an employee leaves only through an exit case,
    // whose HR confirmation records the TERMINATE event (and whose reject or
    // cancel reverses it). A direct exit event would bypass HR/HQ review.
    if matches!(event_type.as_str(), "OFFBOARD" | "TERMINATE") {
        return Err(HrError::validation(
            "OFFBOARD and TERMINATE are recorded by confirming an exit case",
        ));
    }

    let to_status = body
        .to_status
        .map(normalize_enum_text)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default_lifecycle_status(&event_type).to_owned());
    if !to_status.is_empty() && !matches!(to_status.as_str(), "ACTIVE" | "ON_LEAVE" | "UNKNOWN") {
        return Err(HrError::validation(
            "to_status must be ACTIVE, ON_LEAVE, or UNKNOWN",
        ));
    }

    let effective_date = body.effective_date.trim().to_owned();
    if effective_date.is_empty() {
        return Err(HrError::validation("effective_date is required"));
    }
    // A date after today (KST) schedules the event (see `record_lifecycle_event_tx`).
    let effective_date = parse_yyyy_mm_dd(&effective_date)?.to_string();
    let leave_type = body
        .leave_type
        .map(normalize_enum_text)
        .filter(|value| !value.is_empty());
    match &leave_type {
        Some(_) if event_type != "LEAVE_OF_ABSENCE" => {
            return Err(HrError::validation(
                "leave_type is only allowed for LEAVE_OF_ABSENCE",
            ));
        }
        Some(value) if !LEAVE_TYPES.contains(&value.as_str()) => {
            return Err(HrError::validation(
                "leave_type must be CHILDCARE, MATERNITY, ILLNESS, PERSONAL, or OTHER",
            ));
        }
        _ => {}
    }
    // 0252's employee_lifecycle_events_comment_max: refuse as 422, not 23514 → 500 (H5).
    let comment = normalize_limited_text(body.comment, 1000, "comment")?;
    // BW-13: a PROMOTE by catalog id; the id wins and its label is projected
    // into to_position when the event is prepared.
    let to_job_title_id = body.to_job_title_id;
    if to_job_title_id.is_some() && event_type != "PROMOTE" {
        return Err(HrError::validation(
            "to_job_title_id is only allowed for PROMOTE",
        ));
    }
    let to_position = match to_job_title_id {
        Some(_) => None,
        None => normalize_optional_text(body.to_position),
    };
    if event_type == "PROMOTE"
        && to_position.is_none()
        && to_job_title_id.is_none()
        && body.classify.to_grade_id.is_none()
    {
        return Err(HrError::validation(
            "PROMOTE needs to_position, to_job_title_id or to_grade_id",
        ));
    }
    let expected_return_date = normalize_optional_text(body.expected_return_date);
    if expected_return_date.is_some() && event_type != "LEAVE_OF_ABSENCE" {
        return Err(HrError::validation(
            "expected_return_date is only allowed for LEAVE_OF_ABSENCE",
        ));
    }
    let contract_end_date = normalize_optional_text(body.contract_end_date);
    match (
        event_type == "CONTRACT_RENEWAL",
        contract_end_date.is_some(),
    ) {
        (true, false) => {
            return Err(HrError::validation(
                "contract_end_date is required for CONTRACT_RENEWAL",
            ));
        }
        // MR-24: a 전환 to CONTRACT takes one too (checked with its type).
        (false, true) if event_type != "EMPLOYMENT_TYPE_CHANGE" => {
            return Err(HrError::validation(
                "contract_end_date is only allowed for CONTRACT_RENEWAL and a change to CONTRACT",
            ));
        }
        _ => {}
    }
    let expected_return_date = expected_return_date
        .map(|date| lifecycle_date_on_or_after(&date, &effective_date, "expected_return_date"))
        .transpose()?;
    let contract_end_date = contract_end_date
        .map(|date| lifecycle_date_on_or_after(&date, &effective_date, "contract_end_date"))
        .transpose()?;
    // BW-13: a leave names its type, and CHILDCARE / MATERNITY their return.
    if event_type == "LEAVE_OF_ABSENCE" {
        check_leave_facts(leave_type.as_deref(), expected_return_date.as_deref()).map_err(coded)?;
    }
    let group = event_type == "GROUP_TRANSFER";
    if body.to_workplace_id.is_some() && !group && event_type != "TRANSFER" {
        return Err(HrError::validation(
            "to_workplace_id is only allowed for TRANSFER and GROUP_TRANSFER",
        ));
    }
    // E-S3b 전적: the receiving 사업장 names the 법인; the company text follows it.
    if group && body.to_workplace_id.is_none() {
        return Err(HrError::validation(
            "to_workplace_id is required for GROUP_TRANSFER",
        ));
    }
    if body.group_transfer.is_some() && !group {
        return Err(HrError::validation(
            "group_transfer is only allowed for GROUP_TRANSFER",
        ));
    }
    if group && (body.to_company.is_some() || body.to_org_unit.is_some()) {
        return Err(HrError::validation(
            "GROUP_TRANSFER takes to_workplace_id and to_org_unit_id, not to_company or to_org_unit",
        ));
    }
    let reason_code = normalize_optional_text(body.reason_code);
    if reason_code.is_some() && !matches!(event_type.as_str(), "TRANSFER" | "PROMOTE") {
        return Err(HrError::validation(
            "reason_code is only allowed for TRANSFER and PROMOTE",
        ));
    }

    let classify =
        normalize_classification_change(&event_type, body.classify, contract_end_date.as_deref())?;

    Ok(NormalizedEmployeeLifecycleTransition {
        event_type,
        to_status,
        to_company: normalize_optional_text(body.to_company),
        to_org_unit: normalize_optional_text(body.to_org_unit),
        to_org_unit_id: body.to_org_unit_id,
        to_position,
        expected_return_date,
        contract_end_date,
        leave_type,
        to_job_title_id,
        reason_code,
        to_workplace_id: body.to_workplace_id,
        classify,
        effective_date,
        comment,
        signoffs: body.signoffs,
    })
}

/// `date` as ISO `YYYY-MM-DD`, refused when it precedes an ISO `effective_date`.
fn lifecycle_date_on_or_after(
    date: &str,
    effective_date: &str,
    field: &'static str,
) -> Result<String, HrError> {
    let parsed = parse_yyyy_mm_dd(date)?;
    if parse_yyyy_mm_dd(effective_date).is_ok_and(|effective| parsed < effective) {
        return Err(HrError::validation(format!(
            "{field} must be on or after effective_date"
        )));
    }
    Ok(parsed.to_string())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// A request the wire would refuse, built from a valid one: the domain's own refusals hold
    /// for direct callers (HTTP callers are refused first by the OpenAPI enum).
    fn request(set: impl FnOnce(&mut CreateEmployeeLifecycleEventRequest)) -> String {
        let mut body: CreateEmployeeLifecycleEventRequest = serde_json::from_value(serde_json::json!({
            "event_type": "PROMOTE", "effective_date": "2026-10-19", "comment": "c", "to_position": "p",
        }))
        .unwrap();
        set(&mut body);
        normalize_lifecycle_transition(body).unwrap_err().message
    }

    #[test]
    fn exits_and_an_exited_target_are_refused_for_a_direct_caller() {
        for kind in ["OFFBOARD", "TERMINATE"] {
            assert_eq!(
                request(|b| b.event_type = kind.into()),
                "OFFBOARD and TERMINATE are recorded by confirming an exit case"
            );
        }
        assert_eq!(
            request(|b| b.to_status = Some("EXITED".into())),
            "to_status must be ACTIVE, ON_LEAVE, or UNKNOWN"
        );
    }
}
