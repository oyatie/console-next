//! Advancing a close job on (or after) its 폐쇄일, in the caller's
//! transaction, all-or-none: each 부서 the plan moves goes under its new
//! 사업장 first, then each 전근 is recorded as the single-event path records
//! it (prepare, BW-11 guards, record: a dated TRANSFER with the assignment
//! split, `to_workplace_id` naming the 사업장 the unit sits at on the day).
//! While a 퇴직 the plan opened or a 전적 it recorded is not in effect, the
//! job WAITS (the moves and 전근 stay done); once nobody is left, the plan's
//! 부서 are dissolved and the 사업장 closes as a direct close does.

use console_entity_adapter_postgres::OrgUnitSetupWritePort;
use console_entity_adapter_postgres::workplace_close_plan::{self as entity, CloseActor};
use console_hr_domain::lifecycle::classification::ClassificationChange;
use console_kernel_core::{AuditEvent, OrgId, UserId};
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use time::Date;
use uuid::Uuid;

use super::rows::{self, Head, Line};
use super::types::{entity_error, plan_refused};
use crate::HrError;
use crate::lifecycle::guards::{RecordGuards, check_record_guards};
use crate::lifecycle::normalize::normalize_lifecycle_transition;
use crate::lifecycle::prepare::prepare_lifecycle_event;
use crate::lifecycle::record::record_lifecycle_event_tx;
use crate::lifecycle::requests::CreateEmployeeLifecycleEventRequest;

type Tx<'a, 'b> = &'a mut Transaction<'b, Postgres>;

/// Where an advance left the job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Advanced {
    Applied,
    /// The people whose 퇴직 is not in effect yet.
    Waiting(Vec<Uuid>),
}

/// Advance `job` as of `today` (the date its 전근 are judged against: the
/// real KST date, or the 폐쇄일 for a planning dry run). A refused line
/// returns 422 `close_plan_refused` naming every refused line; the caller
/// rolls back.
pub(crate) async fn advance(
    tx: Tx<'_, '_>,
    org: OrgId,
    job: &Head,
    today: Date,
    port: &dyn OrgUnitSetupWritePort,
    events: &mut Vec<AuditEvent>,
) -> Result<Advanced, HrError> {
    let who = CloseActor {
        org,
        user: UserId::from_uuid(job.actor_id),
        command: job.command_id,
    };
    let lines = rows::lines(tx, job.id).await?;
    for l in lines.iter().filter(|l| !l.done && l.action == "MOVE") {
        let (unit, parent) = (
            l.org_unit_id.unwrap_or_default(),
            l.target_unit_id.unwrap_or_default(),
        );
        events.push(
            entity::reparent(tx, who, unit, parent, port)
                .await
                .map_err(entity_error)?,
        );
        rows::mark_done(tx, job.id, l.seq, None).await?;
    }
    let mut refusals = Vec::new();
    for l in lines.iter().filter(|l| !l.done && l.action == "TRANSFER") {
        match transfer(tx, org, who.user, job, l, today).await? {
            Ok((event_id, audit)) => {
                events.push(audit);
                rows::mark_done(tx, job.id, l.seq, Some(event_id)).await?;
            }
            Err(r) => refusals.push(r),
        }
    }
    if !refusals.is_empty() {
        return Err(plan_refused("close_plan_refused", refusals));
    }
    let mut waiting = Vec::new();
    for l in lines
        .iter()
        .filter(|l| !l.done && matches!(l.action.as_str(), "EXIT" | "GROUP_TRANSFER"))
    {
        let employee = l.employee_id.unwrap_or_default();
        // A 퇴직 is in effect once the person has exited; a 전적 once its event applied.
        let gone: bool = sqlx::query_scalar(
            "SELECT CASE WHEN $2::uuid IS NULL THEN e.employment_status = 'EXITED' \
                    ELSE EXISTS (SELECT 1 FROM employee_lifecycle_events l WHERE l.id = $2 AND l.state = 'APPLIED') END \
             FROM person_employees_current e WHERE e.id = $1",
        )
        .bind(employee)
        .bind(l.lifecycle_event_id.filter(|_| l.action == "GROUP_TRANSFER"))
        .fetch_one(tx.as_mut())
        .await?;
        if gone {
            rows::mark_done(tx, job.id, l.seq, None).await?;
        } else {
            waiting.push(employee);
        }
    }
    if !waiting.is_empty() {
        return Ok(Advanced::Waiting(waiting));
    }
    for l in lines.iter().filter(|l| !l.done && l.action == "DISSOLVE") {
        events.push(
            entity::dissolve(tx, who, l.org_unit_id.unwrap_or_default(), port)
                .await
                .map_err(entity_error)?,
        );
        rows::mark_done(tx, job.id, l.seq, None).await?;
    }
    let scope = entity::scope(tx, job.workplace_id, true)
        .await
        .map_err(entity_error)?;
    entity::close(tx, who, &scope, job.closed_on, port)
        .await
        .map_err(entity_error)?;
    Ok(Advanced::Applied)
}

/// One 전근, as the single-event route records it; a client refusal is the
/// line's (`Ok(Err)`), a fault the request's.
async fn transfer(
    tx: Tx<'_, '_>,
    org: OrgId,
    actor: UserId,
    job: &Head,
    l: &Line,
    today: Date,
) -> Result<Result<(Uuid, AuditEvent), Value>, HrError> {
    let employee = l.employee_id.unwrap_or_default();
    // A savepoint per line: a refusal raised by the database (a trigger)
    // leaves the rest of the plan checkable.
    let mut sp = sqlx::Acquire::begin(&mut *tx).await?;
    let attempt = async {
        let transition = normalize_lifecycle_transition(CreateEmployeeLifecycleEventRequest {
            event_type: "TRANSFER".to_owned(),
            to_status: None,
            to_company: None,
            to_org_unit: None,
            to_org_unit_id: l.target_unit_id,
            to_position: None,
            expected_return_date: None,
            contract_end_date: None,
            leave_type: None,
            to_job_title_id: None,
            reason_code: Some("REORGANIZATION".to_owned()),
            exception_id: None,
            to_workplace_id: l.target_workplace_id,
            group_transfer: None,
            guards: RecordGuards::default(),
            classify: ClassificationChange::default(),
            effective_date: job.closed_on.to_string(),
            comment: "사업장 폐쇄".to_owned(),
            signoffs: Default::default(),
        })?;
        let org_uuid = *org.as_uuid();
        let mut prepared =
            prepare_lifecycle_event(&mut sp, org_uuid, employee, transition, today).await?;
        check_record_guards(
            &mut sp,
            org,
            employee,
            &mut prepared,
            &RecordGuards::default(),
        )
        .await?;
        let (item, audit) =
            record_lifecycle_event_tx(&mut sp, org, actor, employee, &prepared, Some(job.id))
                .await?;
        Ok::<_, HrError>((item.id, audit))
    };
    let result = attempt.await;
    match result {
        Ok(done) => {
            sp.commit().await?;
            Ok(Ok(done))
        }
        Err(e) if e.status.is_client_error() => {
            sp.rollback().await?;
            let mut r = json!({ "employee_id": employee, "code": e.code, "message": e.message });
            if let Some(field) = e
                .refusals
                .as_ref()
                .and_then(|x| x.get(0))
                .and_then(|x| x.get("field"))
            {
                r["field"] = field.clone();
            }
            Ok(Err(r))
        }
        Err(e) => Err(e),
    }
}
