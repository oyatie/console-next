//! The org-change → people seam (UX-R2 ORGCHANGE org-01, org-04): an org
//! change moves its people through the owners' own writes, inside the
//! change's apply transaction.
//!
//! - The 사업장 a unit sits at is the ONE resolver's: its nearest placed
//!   ancestor (`employment_hire::unit_placement`, TR-33; UX-R1 PLACEMENT's
//!   0310 serves the same helper). Never a second resolver.
//! - An ACTIVE person gets a dated TRANSFER lifecycle event (전보 into the
//!   target unit, 전근 too when its 사업장 differs), recorded by hr's own
//!   `record_lifecycle_event_tx` — the same row, assignment split and audit a
//!   전보 from the person's record writes — batched under the change's id.
//! - Anyone else on the roll (휴직 and the other non-ACTIVE states, which hr
//!   refuses a TRANSFER) keeps the record whole without an event: the unit
//!   rebind and the assignment split, the same two writes the event applies.
//!   no 발령 row for them until hr admits an org-change 전보 for a
//!   휴직자 (asked in backend-followups).

use console_entity_adapter_postgres::employment_hire::unit_placement;
use console_entity_adapter_postgres::employment_moves::placement_on;
use console_hr_adapter_postgres::HrError;
use console_hr_adapter_postgres::clock::today_kst;
use console_hr_adapter_postgres::lifecycle::normalize::normalize_lifecycle_transition;
use console_hr_adapter_postgres::lifecycle::placement::{WorkplaceMove, apply_move};
use console_hr_adapter_postgres::lifecycle::prepare::prepare_lifecycle_event;
use console_hr_adapter_postgres::lifecycle::record::record_lifecycle_event_tx;
use console_hr_adapter_postgres::lifecycle::requests::CreateEmployeeLifecycleEventRequest;
use console_kernel_core::{ErrorKind, KernelError, OrgId, UserId};
use console_ontology_canonical_adapter_postgres::employment::{
    assignable_org_unit_name, set_employee_org_unit,
};
use console_orgchange_adapter_postgres::{PeopleMove, PeopleMoveCause, PeopleMoved};
use serde_json::json;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

type Tx<'a, 'b> = &'a mut Transaction<'b, Postgres>;

/// One person on the roll of the moving units, locked for the move.
struct Member {
    id: Uuid,
    unit: Option<Uuid>,
    status: String,
}

/// Moves `what` and returns how many people it changed, with their audits.
pub(crate) async fn move_people(
    tx: Tx<'_, '_>,
    org: OrgId,
    actor: UserId,
    cause: PeopleMoveCause,
    what: PeopleMove,
) -> Result<PeopleMoved, KernelError> {
    let org_uuid = *org.as_uuid();
    let (members, to_unit) = match what {
        PeopleMove::Follow { units } => (members(tx, org_uuid, &units).await?, None),
        PeopleMove::Reassign { from, to, people } => {
            let mut all = members(tx, org_uuid, &[from]).await?;
            if let Some(only) = people {
                all.retain(|m| only.contains(&m.id));
            }
            (all, Some(to))
        }
    };
    let mut moved = PeopleMoved::default();
    for member in members {
        let unit = to_unit.or(member.unit);
        let workplace = new_workplace(tx, org_uuid, member.id, unit, cause.on).await?;
        if to_unit.is_none() && workplace.is_none() {
            continue; // follows a unit that stays at its 사업장
        }
        if member.status == "ACTIVE" {
            let audit = transfer(tx, (org, actor), &cause, member.id, to_unit, workplace).await?;
            moved.audits.push(audit);
        } else {
            keep_whole(
                tx,
                (org_uuid, *actor.as_uuid()),
                &cause,
                member.id,
                to_unit,
                workplace,
            )
            .await?;
        }
        moved.employee_ids.push(member.id);
    }
    moved.people = i64::try_from(moved.employee_ids.len()).unwrap_or(i64::MAX);
    Ok(moved)
}

/// Everyone on the roll bound to one of `units` (the dissolve guard's set:
/// every non-EXITED person), locked in id order.
async fn members(tx: Tx<'_, '_>, org: Uuid, units: &[Uuid]) -> Result<Vec<Member>, KernelError> {
    let texts: Vec<String> = units.iter().map(Uuid::to_string).collect();
    let rows: Vec<(Uuid, Option<Uuid>, String)> = sqlx::query_as(
        "SELECT id, org_unit_id, employment_status FROM employees WHERE org_id = $1 \
         AND (org_unit_id = ANY($2) OR org_unit = ANY($3)) AND employment_status <> 'EXITED' \
         ORDER BY id FOR UPDATE",
    )
    .bind(org)
    .bind(units)
    .bind(&texts)
    .fetch_all(tx.as_mut())
    .await
    .map_err(internal)?;
    Ok(rows
        .into_iter()
        .map(|(id, unit, status)| Member { id, unit, status })
        .collect())
}

/// The 사업장 the person moves to on `on`: the unit's (its nearest placed
/// ancestor's) when it differs from where they are placed then; `None` when
/// it is the same, the unit is not placed, or they have no placement then.
async fn new_workplace(
    tx: Tx<'_, '_>,
    org: Uuid,
    employee: Uuid,
    unit: Option<Uuid>,
    on: time::Date,
) -> Result<Option<WorkplaceMove>, KernelError> {
    let Some(unit) = unit else { return Ok(None) };
    let Some(at) = unit_placement(tx.as_mut(), org, unit).await.map_err(hide)? else {
        return Ok(None);
    };
    let Some(now) = placement_on(tx.as_mut(), org, employee, on)
        .await
        .map_err(hide)?
    else {
        return Ok(None);
    };
    if now.workplace_id == Some(at.workplace_id) {
        return Ok(None);
    }
    Ok(Some(WorkplaceMove {
        from_legal_entity_id: now.legal_entity_id.unwrap_or(at.legal_entity_id),
        legal_entity_id: at.legal_entity_id,
        workplace_id: at.workplace_id,
    }))
}

/// A dated TRANSFER through hr's own record path, batched under the change.
async fn transfer(
    tx: Tx<'_, '_>,
    (org, actor): (OrgId, UserId),
    cause: &PeopleMoveCause,
    employee: Uuid,
    to_unit: Option<Uuid>,
    workplace: Option<WorkplaceMove>,
) -> Result<console_kernel_core::AuditEvent, KernelError> {
    let body: CreateEmployeeLifecycleEventRequest = serde_json::from_value(json!({
        "event_type": "TRANSFER",
        "effective_date": cause.on.to_string(),
        "to_org_unit_id": to_unit,
        "to_workplace_id": workplace.map(|w| w.workplace_id),
        "comment": cause.note,
    }))
    .map_err(|_| KernelError::internal("org-change transfer body did not build"))?;
    let transition = normalize_lifecycle_transition(body).map_err(refusal)?;
    // The change applies on its 시행일 (the worker's date may run ahead of the
    // wall clock in a debug E2E): the event is applied now, never scheduled.
    let today = today_kst().max(cause.on);
    let prepared = prepare_lifecycle_event(tx, *org.as_uuid(), employee, transition, today)
        .await
        .map_err(refusal)?;
    let (_, audit) =
        record_lifecycle_event_tx(tx, org, actor, employee, &prepared, Some(cause.request_id))
            .await
            .map_err(refusal)?;
    Ok(audit)
}

/// The two writes a TRANSFER applies, for a person hr refuses one (휴직 …).
async fn keep_whole(
    tx: Tx<'_, '_>,
    (org, actor): (Uuid, Uuid),
    cause: &PeopleMoveCause,
    employee: Uuid,
    to_unit: Option<Uuid>,
    workplace: Option<WorkplaceMove>,
) -> Result<(), KernelError> {
    if let Some(unit) = to_unit {
        let name = assignable_org_unit_name(tx, org, unit)
            .await
            .map_err(internal)?
            .ok_or_else(|| {
                KernelError::validation("the target unit is not active")
                    .with_code("org_unit_not_assignable")
            })?;
        set_employee_org_unit(tx, org, employee, Some(unit), Some(&name))
            .await
            .map_err(internal)?;
    }
    if let Some(to) = workplace {
        let write = (org, employee, actor);
        apply_move(tx, write, Uuid::new_v4(), to, cause.on, None)
            .await
            .map_err(refusal)?;
    }
    Ok(())
}

/// An hr refusal keeps its kind and code; a server fault is logged, not sent.
fn refusal(error: HrError) -> KernelError {
    let kind = match error.status.as_u16() {
        409 => ErrorKind::Conflict,
        422 | 400 => ErrorKind::Validation,
        404 => ErrorKind::NotFound,
        403 => ErrorKind::Forbidden,
        _ => {
            tracing::error!(error = %error.message, "org-change people move failed");
            return KernelError::internal("the people of the change could not be moved");
        }
    };
    KernelError::new(kind, error.message).with_code(error.code)
}

/// A refusal passes; an internal fault's diagnostics are logged, not sent.
fn hide(error: KernelError) -> KernelError {
    if error.kind == ErrorKind::Internal {
        internal(&error.message)
    } else {
        error
    }
}

fn internal(error: impl std::fmt::Display) -> KernelError {
    tracing::error!(error = %error, "org-change people move failed");
    KernelError::internal("the people of the change could not be moved")
}
