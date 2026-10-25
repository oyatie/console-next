//! HrService::bulk_lifecycle_events: handler body moved from `app/src/hr.rs`
//! (R2-life); PEOPLE-READS-2 adds per-line units and selection by query
//! (`bulk_selection`); BE-EMP-UI moves the validation into `bulk_plan`
//! (shared with the preview) and adds CONTRACT_RENEWAL. The handler keeps
//! the manage gate and the Idempotency-Key header ahead of the call.

use console_entity_adapter_postgres::employment_hire::hire_in_tx;
use console_entity_adapter_postgres::employment_moves::MoveWrite;
use console_kernel_core::{AuditAction, AuditEvent, TraceContext};
use console_platform_authz::Principal;
use console_platform_db::idempotency::{
    IdempotencyClaim, claim_idempotency_key, complete_idempotency_key,
};
use console_platform_db::with_audits;
use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

use super::bulk_job::{BulkProgress, PROGRESS_EVERY};
use super::bulk_plan::{BulkPlan, bulk_input, plan_bulk};
use super::hooks::LifecycleTrailHooks;
use super::record_write::record_in_tx;
use super::requests::{BulkEmployeeLifecycleEventRequest, BulkEmployeeLifecycleEventResponse};
use super::rows::employee_lifecycle_event_from_row;
use super::title_reason::coded;
use crate::clock::today_kst;
use crate::idempotency::idempotency_key_reused;
use crate::lifecycle_event_select;
use crate::{HrError, HrService};

impl HrService {
    /// POST `/api/v1/employees/lifecycle-events/bulk`: one TRANSFER, PROMOTE,
    /// APPOINT, EMPLOYMENT_TYPE_CHANGE or CONTRACT_RENEWAL (dated: a future
    /// date schedules everyone) for up to 500 named employees (or
    /// lines), or a selection by query of up to `MAX_BULK_SELECTION`, all or
    /// nothing. Every employee is locked (in id order)
    /// and validated by the single-event rules first; any refusal rolls the whole
    /// batch back as one 422 naming every refused employee. Otherwise each event
    /// is recorded exactly as the single-event endpoint records it (one
    /// `employee.lifecycle.record` audit each) plus one `employee.lifecycle.bulk`
    /// audit carrying the batch id. A TRANSFER to a placed unit also gives an
    /// unassigned person their initial legal placement in this transaction.
    pub async fn bulk_lifecycle_events(
        &self,
        principal: Principal,
        idempotency_key: String,
        body: BulkEmployeeLifecycleEventRequest,
    ) -> Result<Value, HrError> {
        self.run_bulk_lifecycle_events(principal, idempotency_key, body, None)
            .await
    }

    /// The batch; a job passes its [`BulkProgress`] (PERF-BE CAP-04),
    /// reported from its own connection while this transaction is open.
    pub(crate) async fn run_bulk_lifecycle_events(
        &self,
        principal: Principal,
        idempotency_key: String,
        body: BulkEmployeeLifecycleEventRequest,
        progress: Option<BulkProgress>,
    ) -> Result<Value, HrError> {
        let fingerprint = json!(&body);
        let input = bulk_input(body)?;
        let scope = principal.branch_scope.clone();
        let org = principal.org_id;
        let actor = principal.user_id;
        // One read of today for the whole batch: every employee is scheduled or
        // applied alike.
        let today = today_kst();

        let response = with_audits::<_, _, HrError>(&self.pool, org, |tx| {
            Box::pin(async move {
                match claim_idempotency_key(tx, OPERATION, &idempotency_key, &fingerprint).await? {
                    IdempotencyClaim::Replay(response) => return Ok((response, vec![])),
                    IdempotencyClaim::Mismatch => return Err(idempotency_key_reused()),
                    IdempotencyClaim::Fresh => {}
                }
                step(&progress, "checking", 0, 0);
                let BulkPlan {
                    employee_ids,
                    loaded,
                    refusals,
                } = plan_bulk(tx, org, &input, &scope, today).await?;
                if !refusals.is_empty() {
                    return Err(HrError::bulk_refused(refusals, employee_ids.len()));
                }
                let register =
                    console_platform_db::statutory_read::load_statutory_register(tx.as_mut())
                        .await
                        .map_err(|e| HrError::internal(e.to_string()))?;
                let hooks = LifecycleTrailHooks {
                    register: Some(&register),
                    defer_cases: true,
                };
                let batch_id = Uuid::new_v4();
                let mut audits = Vec::with_capacity(employee_ids.len() + 1);
                let mut event_ids = Vec::with_capacity(employee_ids.len());
                step(&progress, "recording", 0, employee_ids.len());
                for (n, employee_id) in employee_ids.iter().enumerate() {
                    if n > 0 && n % PROGRESS_EVERY == 0 {
                        step(&progress, "recording", n, employee_ids.len());
                    }
                    let prepared = loaded
                        .get(employee_id)
                        .ok_or_else(|| HrError::internal("bulk employee was not loaded"))?;
                    let (id, event) = record_in_tx(
                        tx,
                        org,
                        actor,
                        *employee_id,
                        &prepared.event,
                        Some(batch_id),
                        &hooks,
                    )
                    .await?;
                    if let Some(initial) = &prepared.initial {
                        hire_in_tx(
                            tx.as_mut(),
                            MoveWrite {
                                org_id: *org.as_uuid(),
                                employee_id: *employee_id,
                                actor_id: *actor.as_uuid(),
                                command_id: id,
                            },
                            initial.workplace,
                            initial.from,
                        )
                        .await
                        .map_err(coded)?;
                    }
                    event_ids.push(id);
                    audits.push(event);
                }
                crate::cases::open::events_with_register(
                    tx,
                    *org.as_uuid(),
                    &event_ids,
                    Some(&register),
                )
                .await?;
                let rows = sqlx::query(lifecycle_event_select!("WHERE l.org_id=$1 AND l.id=ANY($2)"))
                    .bind(org.as_uuid()).bind(&event_ids).fetch_all(tx.as_mut()).await?;
                let mut by_id=std::collections::BTreeMap::new();
                for row in rows {
                    let item=employee_lifecycle_event_from_row(row)?;
                    metrics::counter!("hr_employee_lifecycle_events_total", "event_type" => item.event_type.clone()).increment(1);
                    by_id.insert(item.id,item);
                }
                let items=event_ids.iter().map(|id|by_id.remove(id).ok_or_else(|| HrError::internal("recorded lifecycle event is missing"))).collect::<Result<Vec<_>,_>>()?;
                audits.push(
                    AuditEvent::new(
                        Some(actor),
                        AuditAction::new("employee.lifecycle.bulk")
                            .map_err(HrError::from_kernel)?,
                        "employee_lifecycle_batch",
                        batch_id.to_string(),
                        TraceContext::generate(),
                        OffsetDateTime::now_utc(),
                    )
                    .with_org(org)
                    .with_snapshots(
                        None,
                        Some(json!({
                            "batch_id": batch_id,
                            "event_type": &input.transition.event_type,
                            "effective_date": &input.transition.effective_date,
                            "to_org_unit_id": input.transition.to_org_unit_id,
                            "lines": &input.lines,
                            "selection": &input.selection,
                            "to_position": &input.transition.to_position,
                            "employee_ids": &employee_ids,
                            "count": employee_ids.len(),
                        })),
                    ),
                );
                let response =
                    serde_json::to_value(BulkEmployeeLifecycleEventResponse { batch_id, items })
                        .map_err(|_| HrError::internal("response serialization failed"))?;
                complete_idempotency_key(tx, OPERATION, &idempotency_key, &response).await?;
                Ok((response, audits))
            })
        })
        .await?;

        Ok(response)
    }
}

/// The Idempotency-Key operation of a batch (synchronous or a job).
pub(crate) const OPERATION: &str = "employee.lifecycle.bulk";

fn step(progress: &Option<BulkProgress>, phase: &'static str, done: usize, total: usize) {
    if let Some(progress) = progress {
        progress.step(phase, done, total);
    }
}
