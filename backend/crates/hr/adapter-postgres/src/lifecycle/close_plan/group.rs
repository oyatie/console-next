//! A close plan's 전적 lines (decisions #30): each is recorded when the plan
//! is, as the single 전적 records it (prepare, guards, the event dated the
//! 폐쇄일 with the person's consent and continuity, and the sending 법인's
//! settlement case), so the person's history and the case show it at once.
//! The close then waits for each to take effect (`apply::advance`).

use console_hr_domain::lifecycle::classification::ClassificationChange;
use console_kernel_core::AuditEvent;
use serde_json::json;
use sqlx::{Postgres, Transaction};
use time::Date;
use uuid::Uuid;

use std::collections::BTreeMap;

use serde_json::Value;

use super::Planner;
use super::rows::NewLine;
use super::types::{PersonLine, plan_refused};
use super::validate::{Holdings, Tx, target_of};
use crate::HrError;
use crate::authz::{APPOINTMENT_KEYS, authorize_hr_place_any};
use crate::exits::group_transfer_case::sending_branch;
use crate::lifecycle::group_transfer::{
    GroupTransferFacts, normalize_group_transfer, record_group_transfer_act,
};
use crate::lifecycle::guards::{RecordGuards, check_record_guards};
use crate::lifecycle::normalize::normalize_lifecycle_transition;
use crate::lifecycle::prepare::prepare_lifecycle_event;
use crate::lifecycle::record::record_lifecycle_event_tx;
use crate::lifecycle::requests::CreateEmployeeLifecycleEventRequest;

/// The note each 전적 the plan records carries (as the 퇴직 lines' cases do).
const NOTE: &str = "사업장 폐쇄";

/// Record every 전적 line on `on`; a refused line refuses the plan, naming
/// each person (the caller rolls back).
pub(super) async fn record_group_transfers(
    tx: &mut Transaction<'_, Postgres>,
    who: &Planner,
    on: Date,
    today: Date,
    lines: &mut [NewLine],
) -> Result<Vec<AuditEvent>, HrError> {
    // The receiving places inside the planner's 발령 grant, as for a single
    // 전적 (403 `out_of_scope`, the whole plan refused, nothing written).
    for line in lines.iter().filter(|l| l.action == "GROUP_TRANSFER") {
        let place = (None, line.target_workplace_id, line.target_unit_id);
        authorize_hr_place_any(tx, &who.principal, &APPOINTMENT_KEYS, place).await?;
    }
    let (mut events, mut refusals) = (Vec::new(), Vec::new());
    for line in lines.iter_mut().filter(|l| l.action == "GROUP_TRANSFER") {
        let employee = line.employee_id.unwrap_or_default();
        let Some(facts) = line.group_transfer.take() else {
            return Err(HrError::internal("a checked 전적 line has no facts"));
        };
        let mut sp = sqlx::Acquire::begin(&mut *tx).await?;
        let attempt = record_one(
            &mut sp,
            who,
            employee,
            (on, today),
            (line.target_unit_id, line.target_workplace_id),
            &facts,
        )
        .await;
        match attempt {
            Ok((event, case, audits)) => {
                sp.commit().await?;
                (line.lifecycle_event_id, line.exit_case_id) = (Some(event), case);
                events.extend(audits);
            }
            Err(e) if e.status.is_client_error() => {
                sp.rollback().await?;
                refusals
                    .push(json!({ "employee_id": employee, "code": e.code, "message": e.message }));
            }
            Err(e) => return Err(e),
        }
    }
    if refusals.is_empty() {
        Ok(events)
    } else {
        Err(plan_refused("close_plan_refused", refusals))
    }
}

async fn record_one(
    tx: &mut Transaction<'_, Postgres>,
    who: &Planner,
    employee: Uuid,
    (on, today): (Date, Date),
    (unit, workplace): (Option<Uuid>, Option<Uuid>),
    facts: &GroupTransferFacts,
) -> Result<(Uuid, Option<Uuid>, Vec<AuditEvent>), HrError> {
    let transition = normalize_lifecycle_transition(CreateEmployeeLifecycleEventRequest {
        event_type: "GROUP_TRANSFER".to_owned(),
        to_status: None,
        to_company: None,
        to_org_unit: None,
        to_org_unit_id: unit,
        to_position: None,
        expected_return_date: None,
        contract_end_date: None,
        leave_type: None,
        to_job_title_id: None,
        reason_code: None,
        exception_id: None,
        to_workplace_id: workplace,
        group_transfer: None,
        guards: RecordGuards::default(),
        classify: ClassificationChange::default(),
        effective_date: on.to_string(),
        comment: NOTE.to_owned(),
        signoffs: Default::default(),
    })?;
    let org = *who.org.as_uuid();
    let mut prepared = prepare_lifecycle_event(tx, org, employee, transition, today).await?;
    check_record_guards(
        tx,
        who.org,
        employee,
        &mut prepared,
        &RecordGuards::default(),
    )
    .await?;
    let to = prepared
        .target
        .workplace
        .ok_or_else(|| HrError::internal("a 전적 resolved no receiving 사업장"))?;
    let branch = sending_branch(tx, org, employee).await?;
    let (item, audit) =
        record_lifecycle_event_tx(tx, who.org, who.user, employee, &prepared, None).await?;
    let (case, audits) = record_group_transfer_act(
        tx,
        (who.org, who.user),
        (employee, item.id),
        &item.effective_date,
        to,
        facts,
        branch,
        NOTE,
    )
    .await?;
    let events: Vec<AuditEvent> = std::iter::once(audit).chain(audits).collect();
    Ok((item.id, case, events))
}

/// A 전적 line (decisions #30): to a unit at another 법인's open 사업장, the
/// one the line names (the planner's grant was checked on it), with the
/// person's consent and continuity checked as the single 전적 checks them.
/// The plan records the 전적 itself; this only checks the line.
pub(super) async fn line(
    tx: Tx<'_, '_>,
    at: &Holdings<'_>,
    line: &PersonLine,
    closed_on: &str,
) -> Result<Result<NewLine, Value>, HrError> {
    let e = line.employee_id;
    let refuse = |code: &str, message: Option<String>| {
        Ok(Err(
            json!({ "employee_id": e, "code": code, "message": message }),
        ))
    };
    let (Some(unit), Some(named)) = (line.to_org_unit_id, line.to_workplace_id) else {
        return refuse(
            if line.to_org_unit_id.is_none() {
                "to_org_unit_id_required"
            } else {
                "to_workplace_id_required"
            },
            None,
        );
    };
    match target_of(tx, at, unit, &BTreeMap::new()).await? {
        Err(code) => refuse(code, None),
        Ok((_, entity)) if entity == at.scope.legal_entity_id => {
            refuse("group_transfer_same_entity", None)
        }
        Ok((workplace, _)) if workplace != named => refuse("org_unit_at_other_workplace", None),
        Ok((workplace, _)) => {
            match normalize_group_transfer(line.group_transfer.clone(), "GROUP_TRANSFER", closed_on)
            {
                Err(error) => refuse(error.code, Some(error.message)),
                Ok(facts) => Ok(Ok(NewLine {
                    employee_id: Some(e),
                    org_unit_id: None,
                    action: "GROUP_TRANSFER",
                    target_unit_id: Some(unit),
                    target_workplace_id: Some(workplace),
                    exit_reason_code: None,
                    exit_case_id: None,
                    lifecycle_event_id: None,
                    group_transfer: facts,
                })),
            }
        }
    }
}
