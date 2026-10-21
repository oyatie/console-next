//! UX-R2 ENDS (company-01, worst-case-18, move-17; decisions #21, #28): a
//! 사업장 that still has people or 부서 closes in one act, by a plan with a
//! line for every person (전근 | 퇴직 | 전적, recorded with the plan)
//! and every 부서 directly under it (moved under another open 사업장 | 폐지).
//!
//! - Planned once, fail-closed: 422 `close_plan_incomplete` names everyone and
//!   every 부서 without a line; 422 `close_plan_refused` every line that cannot
//!   apply (checked by actually applying it in a rolled-back savepoint when the
//!   폐쇄일 is later). Nothing is written then.
//! - 퇴직 lines open (or join) exit cases at once: they need their own HR
//!   confirmation before the 폐쇄일.
//! - Applied all-or-none on the 폐쇄일: inline when that is today and the plan
//!   fits a request (`INLINE_LINES`), else by the lifecycle tick
//!   (`advance_due_workplace_closes`), which also finishes a job that WAITED
//!   for its 퇴직 to take effect.
//! - Every write is audited in its transaction (`workplace.close_plan`,
//!   `workplace.close_job.*`, and each 전근's own `employee.lifecycle.record`):
//!   the event stream's source (#27, 0311).

mod apply;
mod exits;
mod group;
mod rows;
mod tick;
pub mod types;
mod validate;

use std::sync::Arc;

use console_entity_adapter_postgres::OrgUnitSetupWritePort;
use console_entity_adapter_postgres::workplace_close_plan::{self as entity, CloseActor};
use console_hr_domain::text::parse_yyyy_mm_dd;
use console_kernel_core::{AuditEvent, OrgId, UserId};
use console_platform_authz::Principal;
use console_platform_db::{with_audits, with_org_conn};
use serde_json::json;
use time::Date;
use uuid::Uuid;

use self::apply::{Advanced, advance};
use self::rows::{NewJob, NewLine};
use self::types::{
    CloseJob, OpenExitCase, WorkplaceClosePlanRequest, WorkplaceClosePlanView, conflict,
    entity_error, field,
};
use self::validate::{Holdings, check};
use crate::clock::today_kst;
use crate::{HrError, HrService};

/// The most lines a request applies (or dry-runs) itself. Measured (#28,
/// tests/close_plan/burst.rs): ~19 ms a line in a debug build, so 2,000 people
/// do not fit the 30 s request timeout; a larger plan is checked line by line
/// on its day by the tick, in one transaction with no request deadline, and a
/// refused line FAILS it with nothing applied.
/// a request-size guard, not a tenant policy; batch the lifecycle
/// writes if a plan this size must answer inline.
const INLINE_LINES: usize = 300;

/// The planner, as the REST face resolved them.
#[derive(Debug, Clone)]
pub struct Planner {
    pub org: OrgId,
    pub user: UserId,
    /// The request's Idempotency-Key.
    pub command: Uuid,
    /// Their grants: a 전적 line is authorized on its receiving place.
    pub principal: Principal,
}

impl HrService {
    /// `GET /api/v1/workplaces/{workplaceId}/close-plan`.
    ///
    /// # Errors
    /// 404 `workplace_not_found`, 409 `workplace_voided`, or faults.
    pub async fn workplace_close_plan(
        &self,
        org: OrgId,
        workplace: Uuid,
    ) -> Result<WorkplaceClosePlanView, HrError> {
        let today = today_kst();
        with_org_conn::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let scope = entity::scope(tx, workplace, false)
                    .await
                    .map_err(entity_error)?;
                let units = match scope.site_org_unit_id {
                    Some(site) => entity::units_under(tx, site).await.map_err(entity_error)?,
                    None => Vec::new(),
                };
                let ids: Vec<Uuid> = scope
                    .site_org_unit_id
                    .into_iter()
                    .chain(units.iter().map(|u| u.org_unit_id))
                    .collect();
                let people = entity::people_at(tx, workplace, &ids, today)
                    .await
                    .map_err(entity_error)?;
                let mut exit_cases = Vec::new();
                for p in &people {
                    if let Some((case_id, status, date)) =
                        exits::open_case(tx, *org.as_uuid(), p.employee_id).await?
                    {
                        exit_cases.push(OpenExitCase {
                            employee_id: p.employee_id,
                            case_id,
                            status,
                            effective_exit_date: date,
                        });
                    }
                }
                let job = match rows::latest_for(tx, workplace).await? {
                    Some(id) => Some(rows::view(tx, id).await?),
                    None => None,
                };
                Ok(WorkplaceClosePlanView {
                    scope,
                    people,
                    units,
                    exit_cases,
                    job,
                })
            })
        })
        .await
    }

    /// `POST /api/v1/workplaces/{workplaceId}/close-plan`: check the plan,
    /// open its 퇴직 cases, and apply it now (폐쇄일 today) or schedule it.
    ///
    /// # Errors
    /// 409 `workplace_not_open` / `workplace_holds_entity_role` /
    /// `close_job_open` / `idempotency_key_reused`; 422 `closed_on`
    /// (`date_in_past`), `close_plan_incomplete`, `close_plan_refused`.
    pub async fn plan_workplace_close(
        &self,
        who: Planner,
        workplace: Uuid,
        body: WorkplaceClosePlanRequest,
        port: Arc<dyn OrgUnitSetupWritePort>,
    ) -> Result<CloseJob, HrError> {
        let today = today_kst();
        let closer = CloseActor {
            org: who.org,
            user: who.user,
            command: who.command,
        };
        with_audits::<_, _, HrError>(&self.pool, who.org, move |tx| {
            Box::pin(async move {
                let request = json!({ "workplace_id": workplace, "plan": &body });
                if let Some(job) = entity::claim_plan(tx, closer, request).await.map_err(entity_error)? {
                    return Ok((rows::view(tx, job).await?, vec![]));
                }
                let on = parse_yyyy_mm_dd(&body.closed_on).map_err(|_| field("closed_on", "invalid_date"))?;
                if on < today {
                    return Err(field("closed_on", "date_in_past"));
                }
                let scope = entity::scope(tx, workplace, true).await.map_err(entity_error)?;
                if scope.closed_on.is_some() {
                    return Err(conflict("workplace_not_open", "the workplace is already closed"));
                }
                if scope.holds_entity_role {
                    return Err(conflict("workplace_holds_entity_role", "the workplace is the 대표 or 본점 사업장; change the 법인's roles first"));
                }
                if open_job(tx, workplace).await? {
                    return Err(conflict("close_job_open", "a close of this workplace is already planned; cancel it first"));
                }
                let units = match scope.site_org_unit_id {
                    Some(site) => entity::units_under(tx, site).await.map_err(entity_error)?,
                    None => Vec::new(),
                };
                let ids: Vec<Uuid> = scope.site_org_unit_id.into_iter().chain(units.iter().map(|u| u.org_unit_id)).collect();
                let people = entity::people_at(tx, workplace, &ids, today).await.map_err(entity_error)?;
                let at = Holdings { scope: &scope, units: &units, people: &people };
                let mut lines = check(tx, who.org, &at, &body).await?;
                let mut events = open_exits(tx, &who, on, &mut lines).await?;
                events.extend(group::record_group_transfers(tx, &who, on, today, &mut lines).await?);
                let job = NewJob { id: Uuid::new_v4(), workplace_id: workplace, legal_entity_id: scope.legal_entity_id, closed_on: on,
                    reason_code: body.reason_code.as_deref(), actor_id: *who.user.as_uuid(), command_id: who.command };
                rows::insert(tx, &job, &lines).await?;
                let head = rows::head(tx, job.id, false).await?.ok_or_else(|| HrError::internal("close job vanished"))?;
                let inline = lines.len() <= INLINE_LINES;
                let state = if on == today && inline {
                    match advance(tx, who.org, &head, today, port.as_ref(), &mut events).await? {
                        Advanced::Applied => "APPLIED",
                        Advanced::Waiting(_) => "WAITING",
                    }
                } else {
                    if inline {
                        // A dry run on the 폐쇄일: every line is applied in a
                        // savepoint and rolled back, so a refusal surfaces now.
                        let mut dry = sqlx::Acquire::begin(&mut *tx).await?;
                        advance(&mut dry, who.org, &head, on, port.as_ref(), &mut Vec::new()).await?;
                        dry.rollback().await?;
                    }
                    "SCHEDULED"
                };
                if state != "SCHEDULED" {
                    rows::set_state(tx, job.id, state, None).await?;
                }
                let counts = json!({ "job_id": job.id, "closed_on": on.to_string(), "state": state, "lines": lines.len(),
                    "transfer": lines.iter().filter(|l| l.action == "TRANSFER").count(),
                    "exit": lines.iter().filter(|l| l.action == "EXIT").count(),
                    "group_transfer": lines.iter().filter(|l| l.action == "GROUP_TRANSFER").count() });
                events.push(entity::job_event(tx, closer, "workplace.close_plan", workplace, counts).await.map_err(entity_error)?);
                if state == "APPLIED" {
                    events.push(entity::job_event(tx, closer, "workplace.close_job.apply", workplace, json!({ "job_id": job.id })).await.map_err(entity_error)?);
                }
                entity::finish_plan(tx, closer, job.id).await.map_err(entity_error)?;
                Ok((rows::view(tx, job.id).await?, events))
            })
        })
        .await
    }

    /// `POST /api/v1/workplaces/{workplaceId}/close-plan/cancel`: withdraw the
    /// open job. Its 퇴직 cases and 전적 stay (withdraw them on their own).
    ///
    /// # Errors
    /// 409 `close_job_not_open`.
    pub async fn cancel_workplace_close(
        &self,
        who: Planner,
        workplace: Uuid,
    ) -> Result<CloseJob, HrError> {
        let closer = CloseActor {
            org: who.org,
            user: who.user,
            command: who.command,
        };
        with_audits::<_, _, HrError>(&self.pool, who.org, move |tx| {
            Box::pin(async move {
                entity::scope(tx, workplace, true)
                    .await
                    .map_err(entity_error)?;
                let job = match rows::latest_for(tx, workplace).await? {
                    Some(id) if open_job(tx, workplace).await? => id,
                    _ => {
                        return Err(conflict(
                            "close_job_not_open",
                            "no close of this workplace is planned",
                        ));
                    }
                };
                rows::set_state(tx, job, "CANCELLED", None).await?;
                let event = entity::job_event(
                    tx,
                    closer,
                    "workplace.close_job.cancel",
                    workplace,
                    json!({ "job_id": job }),
                )
                .await
                .map_err(entity_error)?;
                Ok((rows::view(tx, job).await?, vec![event]))
            })
        })
        .await
    }
}

async fn open_job(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workplace: Uuid,
) -> Result<bool, HrError> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM workplace_close_jobs WHERE workplace_id = $1 AND state IN ('SCHEDULED', 'WAITING'))",
    )
    .bind(workplace)
    .fetch_one(tx.as_mut())
    .await?)
}

/// Open (or join) each 퇴직 line's exit case; any person who cannot leave
/// that day refuses the plan.
async fn open_exits(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    who: &Planner,
    on: Date,
    lines: &mut [NewLine],
) -> Result<Vec<AuditEvent>, HrError> {
    let (mut events, mut refusals) = (Vec::new(), Vec::new());
    for line in lines.iter_mut().filter(|l| l.action == "EXIT") {
        let (employee, reason) = (
            line.employee_id.unwrap_or_default(),
            line.exit_reason_code.clone().unwrap_or_default(),
        );
        match exits::open_for_close(tx, who.org, who.user, employee, on, &reason).await? {
            Ok((case, event)) => {
                line.exit_case_id = Some(case);
                events.extend(event);
            }
            Err(r) => refusals.push(r),
        }
    }
    if refusals.is_empty() {
        Ok(events)
    } else {
        Err(types::plan_refused("close_plan_refused", refusals))
    }
}
