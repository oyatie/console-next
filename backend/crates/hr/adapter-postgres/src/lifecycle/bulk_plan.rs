//! The half of a bulk lifecycle batch that writes nothing: the request's
//! per-kind rules, then every named employee validated by the single-event
//! rules (BW-11 guards, the two-year rule of a CONTRACT_RENEWAL). The commit
//! (`bulk`) and its preview (`bulk_preview`) run exactly this, so the counts
//! a preview shows are the ones the commit meets.

use std::collections::{BTreeMap, BTreeSet};

use console_hr_domain::lifecycle::classification::ClassificationChange;
use console_hr_domain::lifecycle::event::NormalizedEmployeeLifecycleTransition;
use console_hr_domain::text::normalize_enum_text;
use console_kernel_core::{BranchScope, OrgId};
use serde_json::{Value, json};
use time::Date;
use uuid::Uuid;

use super::bulk_selection::{
    BulkSelection, BulkTransferLine, resolve_selection, validate_bulk_targets,
};
use super::fixed_term::check_fixed_term_renewal;
use super::guards::{RecordGuards, check_record_guards};
use super::normalize::normalize_lifecycle_transition;
use super::prepare::{PreparedLifecycleEvent, prepare_lifecycle_event};
use super::requests::{BulkEmployeeLifecycleEventRequest, CreateEmployeeLifecycleEventRequest};
use super::title_reason::validate_lifecycle_reason;
use crate::HrError;
use crate::directory::create::require_assignable_org_unit;

/// The kinds a batch takes. CONTRACT_RENEWAL (EMP-UI 8, E6-renew) runs the
/// single route's two-year rule per person; a batch carries no exception, so
/// a renewal past the limit is that person's `fixed_term_limit` refusal.
const BULK_KINDS: [&str; 5] = [
    "TRANSFER",
    "PROMOTE",
    "APPOINT",
    "EMPLOYMENT_TYPE_CHANGE",
    "CONTRACT_RENEWAL",
];

/// A checked batch request.
pub(super) struct BulkInput {
    pub transition: NormalizedEmployeeLifecycleTransition,
    pub units: BTreeMap<Uuid, Uuid>,
    pub lines: Vec<BulkTransferLine>,
    pub employee_ids: Vec<Uuid>,
    pub selection: Option<BulkSelection>,
}

/// Every employee of the batch, validated: `refusals` is empty exactly when
/// the commit may record `loaded` for `employee_ids`.
pub(super) struct BulkPlan {
    pub employee_ids: Vec<Uuid>,
    pub loaded: BTreeMap<Uuid, PreparedLifecycleEvent>,
    pub refusals: Vec<Value>,
}

/// The request's own rules (no database).
pub(super) fn bulk_input(body: BulkEmployeeLifecycleEventRequest) -> Result<BulkInput, HrError> {
    let event_type = normalize_enum_text(body.event_type.clone());
    if !BULK_KINDS.contains(&event_type.as_str()) {
        return Err(HrError::validation(
            "bulk event_type must be TRANSFER, PROMOTE, APPOINT, EMPLOYMENT_TYPE_CHANGE or CONTRACT_RENEWAL",
        ));
    }
    let per_line = !body.lines.is_empty();
    if per_line && event_type != "TRANSFER" {
        return Err(HrError::validation("lines are only allowed for TRANSFER"));
    }
    if per_line && body.to_org_unit_id.is_some() {
        return Err(HrError::validation(
            "to_org_unit_id is given per line when lines are used",
        ));
    }
    if event_type == "TRANSFER" && !per_line && body.to_org_unit_id.is_none() {
        return Err(HrError::validation(
            "to_org_unit_id is required for TRANSFER",
        ));
    }
    if event_type != "PROMOTE" && (body.to_position.is_some() || body.to_job_title_id.is_some()) {
        return Err(HrError::validation(
            "to_position is only allowed for PROMOTE",
        ));
    }
    if event_type != "TRANSFER" && body.to_org_unit_id.is_some() {
        return Err(HrError::validation(
            "to_org_unit_id is only allowed for TRANSFER",
        ));
    }
    validate_bulk_targets(&body.employee_ids, &body.lines, body.selection.as_ref())?;
    let units = body
        .lines
        .iter()
        .map(|line| (line.employee_id, line.to_org_unit_id))
        .collect();
    let transition = normalize_lifecycle_transition(CreateEmployeeLifecycleEventRequest {
        event_type,
        to_status: None,
        to_company: None,
        to_org_unit: None,
        to_org_unit_id: body.to_org_unit_id,
        to_position: body.to_position,
        expected_return_date: None,
        contract_end_date: body.contract_end_date,
        leave_type: None,
        to_job_title_id: body.to_job_title_id,
        reason_code: body.reason_code,
        exception_id: None,
        to_workplace_id: None,
        group_transfer: None,
        guards: RecordGuards::default(),
        classify: ClassificationChange {
            to_grade_id: body.to_grade_id,
            to_position_kind_id: body.to_position_kind_id,
            vacate_position_kind: body.vacate_position_kind,
            to_job_id: body.to_job_id,
            to_job: body.to_job,
            to_job_family_id: body.to_job_family_id,
            to_employment_type: body.to_employment_type,
        },
        effective_date: body.effective_date,
        comment: body.comment,
        signoffs: body.signoffs,
    })?;
    Ok(BulkInput {
        transition,
        units,
        lines: body.lines,
        employee_ids: body.employee_ids,
        selection: body.selection,
    })
}

/// Resolves and locks (id order, deadlock-free against a concurrent batch)
/// every employee and validates each one; a client refusal is the
/// employee's, a server fault the request's.
pub(super) async fn plan_bulk(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: OrgId,
    input: &BulkInput,
    scope: &BranchScope,
    today: Date,
) -> Result<BulkPlan, HrError> {
    let org_uuid = *org.as_uuid();
    validate_lifecycle_reason(tx, org, &input.transition).await?;
    let employee_ids = match &input.selection {
        Some(selection) => resolve_selection(tx, selection, scope).await?,
        None if !input.lines.is_empty() => {
            input.lines.iter().map(|line| line.employee_id).collect()
        }
        None => input.employee_ids.clone(),
    };
    let destinations: BTreeSet<Uuid> = input
        .transition
        .to_org_unit_id
        .into_iter()
        .chain(input.units.values().copied())
        .collect();
    for org_unit_id in destinations {
        require_assignable_org_unit(tx, org_uuid, org_unit_id).await?;
    }
    let distinct: BTreeSet<Uuid> = employee_ids.iter().copied().collect();
    let (mut loaded, mut refusals) = (BTreeMap::new(), Vec::new());
    for employee_id in distinct {
        let transition = transition_for(&input.transition, &input.units, employee_id);
        match prepare_one(tx, org, employee_id, transition, today).await {
            Ok(prepared) => {
                loaded.insert(employee_id, prepared);
            }
            Err(error) if error.status.is_client_error() => {
                let mut refusal = json!({
                    "employee_id": employee_id,
                    "code": error.code,
                    "message": error.message,
                });
                // The input the refusal names (TR-33 `transfer_cross_entity`).
                if let Some(field) = error.refusals.as_ref().and_then(|r| r[0].get("field")) {
                    refusal["field"] = field.clone();
                }
                refusals.push(refusal);
            }
            Err(error) => return Err(error),
        }
    }
    Ok(BulkPlan {
        employee_ids,
        loaded,
        refusals,
    })
}

async fn prepare_one(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: OrgId,
    employee_id: Uuid,
    transition: NormalizedEmployeeLifecycleTransition,
    today: Date,
) -> Result<PreparedLifecycleEvent, HrError> {
    let org_uuid = *org.as_uuid();
    let mut prepared =
        prepare_lifecycle_event(tx, org_uuid, employee_id, transition, today).await?;
    // BW-11: the hire-date floor and no silent supersede, per employee.
    check_record_guards(
        tx,
        org,
        employee_id,
        &mut prepared,
        &RecordGuards::default(),
    )
    .await?;
    if prepared.transition.event_type == "CONTRACT_RENEWAL" {
        check_fixed_term_renewal(tx, org_uuid, employee_id, &prepared.transition, None).await?;
    }
    Ok(prepared)
}

/// The employee's own transition: the batch's, with its line's unit when the
/// batch is per line.
fn transition_for(
    batch: &NormalizedEmployeeLifecycleTransition,
    units: &BTreeMap<Uuid, Uuid>,
    employee_id: Uuid,
) -> NormalizedEmployeeLifecycleTransition {
    let mut transition = batch.clone();
    if let Some(unit) = units.get(&employee_id) {
        transition.to_org_unit_id = Some(*unit);
    }
    transition
}
