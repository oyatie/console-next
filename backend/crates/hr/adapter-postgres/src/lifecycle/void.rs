//! BW-11: 취소·철회 (rescind) of an APPLIED lifecycle event, and the pieces
//! the 정정 (correct) path shares: which event may be voided, and the head it
//! restores. Append-only: the original row is never touched; a RESCIND row (or,
//! for a correction, the replacement) carries `voids_event_id`.
//!
//! only the employee's latest effective event (APPLIED, not a
//! RESCIND, not voided) may be voided, so the restore is just its `from_`
//! columns. Voiding an older event needs a replay of everything after it.

use console_hr_domain::lifecycle::classification::ClassificationColumns;
use console_hr_domain::lifecycle::event::EmployeeForLifecycle;
use console_hr_domain::lifecycle::schedule::ScheduleChange;
use console_kernel_core::{KernelError, OrgId, UserId};
use console_ontology_canonical_adapter_postgres::{employment, employment_job_title};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row;
use time::Date;
use uuid::Uuid;

use super::classification::{load_before, restore_classification, write_restored};
use super::hooks::{apply_event, rescinded};
use super::placement::undo_move;
use super::record::load_lifecycle_event;
use super::schedule_sql::{replay_lifecycle_schedule, scheduled_cascades};
use super::store::load_employee_for_lifecycle;
pub(super) use super::title_reason::check_void_reason;
use super::title_reason::coded;
use super::types::EmployeeLifecycleEventResponse;
use crate::HrError;

/// Body of `POST …/lifecycle-events/{event_id}/rescind` and of the batch rescind.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RescindLifecycleEventRequest {
    /// A `lifecycle_cancel` code.
    pub reason_code: String,
    #[serde(default)]
    pub note: Option<String>,
    /// False (the default) previews `cascades` and writes nothing.
    #[serde(default)]
    pub confirm_cascades: bool,
}

#[derive(Debug, Serialize)]
pub struct RescindOutcome {
    /// The employee's SCHEDULED events, re-validated against the restored
    /// head when the rescission runs (a conflict then refuses it).
    pub cascades: Vec<Value>,
    /// The RESCIND row, once confirmed.
    pub rescinded: Option<EmployeeLifecycleEventResponse>,
}

/// The `from_` side of the event being voided.
pub(super) struct Original {
    pub id: Uuid,
    pub event_type: String,
    pub effective_date: String,
    pub expected_return_date: Option<Date>,
    pub contract_end_date: Option<Date>,
    from_status: Option<String>,
    from_company: Option<String>,
    from_org_unit: Option<String>,
    from_position: Option<String>,
    from_org_unit_id: Option<Uuid>,
    from_job_title_id: Option<Uuid>,
    from_contract_end_date: Option<Date>,
    to_org_unit_id: Option<Uuid>,
    /// E-S3b: the 사업장 the event moved the employee to, if it moved them.
    to_workplace_id: Option<Uuid>,
    /// MR-24/25: the 직급·직책·직무·직군 and employment window it replaced.
    before: (ClassificationColumns, Option<Date>),
}

fn refusal(code: &'static str, message: &str) -> HrError {
    coded(KernelError::invalid_transition(message.to_owned()).with_code(code))
}

/// Locks and loads the event, refusing anything but the latest effective one.
pub(super) async fn load_voidable(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: Uuid,
    employee: Uuid,
    event_id: Uuid,
) -> Result<Original, HrError> {
    let row = sqlx::query(
        "SELECT l.event_type, l.state, l.effective_date, l.expected_return_date, \
                l.contract_end_date, l.from_status, l.from_company, l.from_org_unit, \
                l.from_position, l.from_org_unit_id, l.from_job_title_id, \
                l.from_contract_end_date, l.to_org_unit_id, l.to_workplace_id, \
                EXISTS (SELECT 1 FROM employee_lifecycle_events v WHERE v.voids_event_id = l.id) AS voided, \
                (SELECT x.id FROM employee_lifecycle_events x \
                  WHERE x.org_id = l.org_id AND x.employee_id = l.employee_id \
                    AND x.state = 'APPLIED' AND x.event_type <> 'RESCIND' \
                    AND NOT EXISTS (SELECT 1 FROM employee_lifecycle_events v \
                                    WHERE v.voids_event_id = x.id) \
                  ORDER BY x.created_at DESC, x.id DESC LIMIT 1) AS latest \
         FROM employee_lifecycle_events l \
         WHERE l.org_id = $1 AND l.employee_id = $2 AND l.id = $3 FOR UPDATE OF l",
    )
    .bind(org)
    .bind(employee)
    .bind(event_id)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| HrError::from_kernel(KernelError::not_found("lifecycle event not found")))?;
    let kind: String = row.try_get("event_type")?;
    let state: String = row.try_get("state")?;
    let voided: bool = row.try_get("voided")?;
    let latest: Option<Uuid> = row.try_get("latest")?;
    if state != "APPLIED" {
        return Err(refusal(
            "lifecycle_void_not_applied",
            "only an APPLIED event can be corrected or rescinded",
        ));
    }
    if matches!(kind.as_str(), "TERMINATE" | "OFFBOARD" | "EXIT_REVERSAL") {
        return Err(refusal(
            "lifecycle_void_exit_owned",
            "an exit is reversed by rejecting its exit case with a reason",
        ));
    }
    if matches!(kind.as_str(), "ONBOARD" | "REHIRE" | "RESCIND") {
        return Err(refusal(
            "lifecycle_void_unsupported",
            "this event cannot be corrected or rescinded",
        ));
    }
    if voided {
        return Err(refusal(
            "lifecycle_event_voided",
            "this event was already corrected or rescinded",
        ));
    }
    if latest != Some(event_id) {
        return Err(refusal(
            "lifecycle_void_not_latest",
            "only the employee's latest change can be corrected or rescinded; void the later ones first",
        ));
    }
    Ok(Original {
        id: event_id,
        event_type: kind,
        effective_date: row.try_get("effective_date")?,
        expected_return_date: row.try_get("expected_return_date")?,
        contract_end_date: row.try_get("contract_end_date")?,
        from_status: row.try_get("from_status")?,
        from_company: row.try_get("from_company")?,
        from_org_unit: row.try_get("from_org_unit")?,
        from_position: row.try_get("from_position")?,
        from_org_unit_id: row.try_get("from_org_unit_id")?,
        from_job_title_id: row.try_get("from_job_title_id")?,
        from_contract_end_date: row.try_get("from_contract_end_date")?,
        to_org_unit_id: row.try_get("to_org_unit_id")?,
        to_workplace_id: row.try_get("to_workplace_id")?,
        before: load_before(tx, org, event_id).await?,
    })
}

/// The head with `original` undone (in memory).
pub(super) fn restored_head(
    live: &EmployeeForLifecycle,
    original: &Original,
) -> EmployeeForLifecycle {
    let mut head = live.clone();
    if let Some(status) = &original.from_status {
        head.employment_status.clone_from(status);
    }
    if let Some(company) = &original.from_company {
        head.company.clone_from(company);
    }
    head.org_unit.clone_from(&original.from_org_unit);
    head.position.clone_from(&original.from_position);
    if matches!(original.event_type.as_str(), "TRANSFER" | "GROUP_TRANSFER")
        && original.to_org_unit_id.is_some()
    {
        head.org_unit_id = original.from_org_unit_id;
    }
    restore_classification(&mut head, &original.event_type, &original.before);
    if original.event_type == "PROMOTE" {
        head.job_title_id = original.from_job_title_id;
    }
    head
}

/// Validates the restored head against the employee's SCHEDULED events, then
/// writes it (the Employment owner's change-window check refuses a locked
/// month: the payroll-cutoff bound of a rescission), reverses its 전근
/// (E-S3b; `undo` = (actor, the undoing command's id)) and runs `on_rescind`
/// for the voided event (rescind, and the void half of a correction).
pub(super) async fn restore_head(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: Uuid,
    employee: Uuid,
    original: &Original,
    undo: (Uuid, Uuid),
) -> Result<EmployeeForLifecycle, HrError> {
    let live = load_employee_for_lifecycle(tx, org, employee).await?;
    let head = restored_head(&live, original);
    replay_lifecycle_schedule(
        tx,
        org,
        employee,
        &live,
        ScheduleChange::Head(Box::new(head.clone())),
    )
    .await?;
    employment::apply_employment_change(
        tx,
        org,
        employee,
        employment::EmploymentChange {
            company: &head.company,
            org_unit: head.org_unit.as_deref(),
            position: head.position.as_deref(),
            employment_status: &head.employment_status,
            effective_date: &original.effective_date,
        },
    )
    .await?;
    if matches!(original.event_type.as_str(), "TRANSFER" | "GROUP_TRANSFER")
        && original.to_org_unit_id.is_some()
    {
        employment::set_employee_org_unit(tx, org, employee, head.org_unit_id, None).await?;
    }
    write_restored(tx, org, employee, &original.event_type, &head).await?;
    if let Some(workplace) = original.to_workplace_id {
        let (actor, command) = undo;
        let on = &original.effective_date;
        undo_move(tx, (org, employee, actor), command, on, workplace).await?;
    }
    if original.event_type == "CONTRACT_RENEWAL" {
        sqlx::query(
            "UPDATE employee_employment_profiles SET contract_end_date = $3 \
             WHERE org_id = $1 AND employee_id = $2",
        )
        .bind(org)
        .bind(employee)
        .bind(original.from_contract_end_date)
        .execute(tx.as_mut())
        .await?;
    }
    employment_job_title::bump_head_version(tx, org, employee).await?;
    let event = apply_event(
        org,
        original.id,
        employee,
        &original.event_type,
        &original.effective_date,
    )?;
    rescinded(tx, &event).await?;
    Ok(live)
}

/// Rescinds one event inside the caller's transaction (reason already checked).
pub(super) async fn rescind_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: OrgId,
    actor: UserId,
    employee: Uuid,
    event_id: Uuid,
    request: &RescindLifecycleEventRequest,
    batch_id: Option<Uuid>,
) -> Result<RescindOutcome, HrError> {
    let org_uuid = *org.as_uuid();
    let original = load_voidable(tx, org_uuid, employee, event_id).await?;
    let cascades = scheduled_cascades(tx, org_uuid, employee).await?;
    if !request.confirm_cascades {
        return Ok(RescindOutcome {
            cascades,
            rescinded: None,
        });
    }
    let id = Uuid::new_v4();
    let live = restore_head(tx, org_uuid, employee, &original, (*actor.as_uuid(), id)).await?;
    let head = restored_head(&live, &original);
    sqlx::query(
        "INSERT INTO employee_lifecycle_events (id, org_id, employee_id, event_type, \
           from_status, to_status, from_company, to_company, from_org_unit, to_org_unit, \
           from_position, to_position, effective_date, comment, reason_code, signoffs, \
           created_by, voids_event_id, batch_id) \
         VALUES ($1, $2, $3, 'RESCIND', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, \
           '{}'::jsonb, $15, $16, $17)",
    )
    .bind(id)
    .bind(org_uuid)
    .bind(employee)
    .bind(&live.employment_status)
    .bind(&head.employment_status)
    .bind(&live.company)
    .bind(&head.company)
    .bind(live.org_unit.as_deref())
    .bind(head.org_unit.as_deref())
    .bind(live.position.as_deref())
    .bind(head.position.as_deref())
    .bind(&original.effective_date)
    .bind(
        request
            .note
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty()),
    )
    .bind(request.reason_code.trim())
    .bind(*actor.as_uuid())
    .bind(original.id)
    .bind(batch_id)
    .execute(tx.as_mut())
    .await?;
    crate::cases::open::cancel(
        tx,
        org_uuid,
        original.id,
        request
            .note
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .unwrap_or(request.reason_code.trim()),
    )
    .await?;
    let rescinded = load_lifecycle_event(tx, org_uuid, id).await?;
    Ok(RescindOutcome {
        cascades,
        rescinded: Some(rescinded),
    })
}
