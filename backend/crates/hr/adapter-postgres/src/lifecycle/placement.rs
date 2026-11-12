//! E-S3b: the legal entity · workplace side of a lifecycle event (ED §3.9,
//! first-run §2).
//!
//! - Leave and transfers recorded while the tenant is in SETUP are setup
//!   records (decisions #26: migrating in must not dead-end), governed after
//!   go-live ([`lifecycle_change_mode`]). Exits are refused by EXIT's exit
//!   case (E-S2) before they reach the lifecycle.
//! - A TRANSFER moves the employee to another workplace of the same legal
//!   entity (a workplace transfer) when it names `to_workplace_id`, or when the unit it
//!   moves them to sits at another workplace. The entity crate splits the
//!   assignment in this transaction ([`apply_move`]); rescinding or correcting
//!   the event reverses it ([`undo_move`]). A move to another legal entity is
//!   a group transfer, never a TRANSFER: a unit (or workplace) of another
//!   legal entity is refused (422 `transfer_cross_entity`, TR-33, decisions
//!   #30), whatever its depth.
//! - A GROUP_TRANSFER (group transfer) moves them to a workplace of another
//!   legal entity: the same split, with the event id as the assignments'
//!   `group_transfer_id`.

use console_entity_adapter_postgres::employment_hire::unit_placement;
use console_entity_adapter_postgres::employment_moves::{
    self, MoveTarget, MoveWrite, entity_label, open_workplace_entity, placement_on, unit_workplace,
};
use console_hr_domain::lifecycle::event::NormalizedEmployeeLifecycleTransition;
use console_hr_domain::text::parse_yyyy_mm_dd;
use console_kernel_core::tenant_phase::admit_write;
use console_kernel_core::{ChangeMode, KernelError, TenantPhase, WriteClass};
use http::StatusCode;
use serde_json::json;
use sqlx::Postgres;
use time::Date;
use uuid::Uuid;

use super::title_reason::coded;
use crate::HrError;

type Tx<'a, 'b> = &'a mut sqlx::Transaction<'b, Postgres>;

/// The workplace (and its legal entity) a TRANSFER or GROUP_TRANSFER moves
/// the employee to, and the legal entity they leave.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkplaceMove {
    pub from_legal_entity_id: Uuid,
    pub legal_entity_id: Uuid,
    pub workplace_id: Uuid,
}

/// The lifecycle acts whose admission depends on the tenant phase.
fn phase_bound(event_type: &str) -> bool {
    matches!(
        event_type,
        "TRANSFER" | "GROUP_TRANSFER" | "LEAVE_OF_ABSENCE" | "RETURN_FROM_LEAVE"
    )
}

/// How a leave or transfer is admitted: `SETUP` (a setup record) while the
/// tenant is in SETUP, `GOVERNED` after go-live; `None` for any other act.
/// The phase is read `FOR SHARE`, so a concurrent go-live (`FOR UPDATE`)
/// serialises with it; a missing row reads as OPERATING.
///
/// # Errors
/// A database fault.
pub async fn lifecycle_change_mode(
    tx: Tx<'_, '_>,
    org: Uuid,
    event_type: &str,
) -> Result<Option<ChangeMode>, HrError> {
    if !phase_bound(event_type) {
        return Ok(None);
    }
    let phase: Option<String> =
        sqlx::query_scalar("SELECT phase FROM tenant_phase WHERE org_id = $1 FOR SHARE")
            .bind(org)
            .fetch_optional(tx.as_mut())
            .await?;
    admit_write(
        TenantPhase::from_db(phase.as_deref()),
        WriteClass::LifecycleRecord,
    )
    .map(Some)
    .map_err(coded)
}

/// 422 `transfer_cross_entity`: the TRANSFER's target (`field` = `value`)
/// sits in another legal entity than the employee's on its date. A
/// reassignment never crosses legal entities; that move is a group transfer
/// (decisions #30). Nothing is written.
fn cross_entity(field: &str, value: Uuid, from: Uuid, to: Uuid) -> HrError {
    HrError {
        errors: None,
        status: StatusCode::UNPROCESSABLE_ENTITY,
        code: "transfer_cross_entity",
        message: "a transfer stays inside the employee's 법인; moving to another 법인 is a 전적"
            .to_owned(),
        refusals: Some(Box::new(json!([{
            "field": field,
            "code": "transfer_cross_entity",
            "value": value,
            "from_legal_entity_id": from,
            "to_legal_entity_id": to,
        }]))),
    }
}

/// TR-33: the legal entity of the unit a TRANSFER moves the employee to must
/// be theirs. A department has no placement of its own, so its legal entity
/// is its nearest placed ancestor's (the workplace's SITE unit); an unplaced
/// unit is not judged.
async fn same_entity_unit(
    tx: Tx<'_, '_>,
    org: Uuid,
    unit: Uuid,
    from: Uuid,
) -> Result<(), HrError> {
    match unit_placement(tx.as_mut(), org, unit)
        .await
        .map_err(coded)?
    {
        Some(at) if at.legal_entity_id != from => Err(cross_entity(
            "to_org_unit_id",
            unit,
            from,
            at.legal_entity_id,
        )),
        _ => Ok(()),
    }
}

/// The transfer a TRANSFER makes, if any: the explicit `to_workplace_id`, else
/// the workplace of the unit it moves the employee to. `None` when the
/// employee stays at their workplace, or when only the unit implies a move
/// and the employee has no legal entity recorded (the "clean up company
/// names" cleanup places them).
///
/// # Errors
/// 422 `org_unit_at_other_workplace` / `workplace_not_open` /
/// `transfer_cross_entity`; 409 `employee_unassigned` (explicit move).
pub async fn resolve_workplace_move(
    tx: Tx<'_, '_>,
    org: Uuid,
    employee: Uuid,
    transition: &NormalizedEmployeeLifecycleTransition,
    unit: Option<Uuid>,
) -> Result<Option<WorkplaceMove>, HrError> {
    let group = transition.event_type == "GROUP_TRANSFER";
    if !group && transition.event_type != "TRANSFER" {
        return Ok(None);
    }
    let unit_place = match unit {
        Some(unit) => unit_workplace(tx.as_mut(), org, unit)
            .await
            .map_err(coded)?,
        None => None,
    };
    let explicit = transition.to_workplace_id;
    if let (Some(asked), Some(at)) = (explicit, unit_place)
        && asked != at
    {
        return Err(coded(
            KernelError::validation("the unit sits at another 사업장 than to_workplace_id")
                .with_code("org_unit_at_other_workplace"),
        ));
    }
    let on = parse_yyyy_mm_dd(&transition.effective_date)?;
    let covering = placement_on(tx.as_mut(), org, employee, on)
        .await
        .map_err(coded)?
        .and_then(|p| p.legal_entity_id.map(|entity| (p, entity)));
    if let (false, Some(unit), Some((_, from))) = (group, unit, covering) {
        same_entity_unit(tx, org, unit, from).await?;
    }
    let Some(workplace) = explicit.or(unit_place) else {
        return Ok(None);
    };
    let Some((covering, from)) = covering else {
        return match explicit {
            Some(_) => Err(coded(
                KernelError::conflict("record the employee's 법인 · 사업장 before moving them")
                    .with_code("employee_unassigned"),
            )),
            None => Ok(None),
        };
    };
    if !group && covering.workplace_id == Some(workplace) {
        return Ok(None);
    }
    let entity = open_workplace_entity(tx.as_mut(), org, workplace, Some(on))
        .await
        .map_err(coded)?;
    match (group, from == entity) {
        (false, false) => Err(cross_entity("to_workplace_id", workplace, from, entity)),
        (true, true) => Err(coded(
            KernelError::validation(
                "the 사업장 belongs to the employee's own 법인; moving there is a transfer (전근)",
            )
            .with_code("group_transfer_same_entity"),
        )),
        _ => Ok(Some(WorkplaceMove {
            from_legal_entity_id: from,
            legal_entity_id: entity,
            workplace_id: workplace,
        })),
    }
}

/// The receiving legal entity's name on `on` (a group transfer's company display snapshot).
///
/// # Errors
/// A malformed date; a database fault.
pub async fn receiving_label(
    tx: Tx<'_, '_>,
    org: Uuid,
    to: WorkplaceMove,
    on: &str,
) -> Result<Option<String>, HrError> {
    let on = parse_yyyy_mm_dd(on)?;
    entity_label(tx.as_mut(), org, to.legal_entity_id, on)
        .await
        .map_err(coded)
}

/// Splits the assignment for `event` on its date (the event id is the row's
/// command id).
///
/// # Errors
/// The port's refusals (`assignment_after_move`, `employee_unassigned`).
pub async fn apply_move(
    tx: Tx<'_, '_>,
    write: (Uuid, Uuid, Uuid),
    event: Uuid,
    to: WorkplaceMove,
    on: Date,
    group_transfer_id: Option<Uuid>,
) -> Result<(), HrError> {
    let (org_id, employee_id, actor_id) = write;
    employment_moves::move_in_tx(
        tx.as_mut(),
        MoveWrite {
            org_id,
            employee_id,
            actor_id,
            command_id: event,
        },
        MoveTarget {
            legal_entity_id: to.legal_entity_id,
            workplace_id: to.workplace_id,
            group_transfer_id,
        },
        on,
    )
    .await
    .map(drop)
    .map_err(coded)
}

/// Reverses the move to `workplace` that started on `on` (the voided
/// event's), if it is still the live placement; `undo` is the undoing
/// command's id.
///
/// # Errors
/// 409 `assignment_after_move` when a later assignment depends on it.
pub async fn undo_move(
    tx: Tx<'_, '_>,
    write: (Uuid, Uuid, Uuid),
    undo: Uuid,
    on: &str,
    workplace: Uuid,
) -> Result<(), HrError> {
    let (org_id, employee_id, actor_id) = write;
    let on = parse_yyyy_mm_dd(on)?;
    employment_moves::undo_move_in_tx(
        tx.as_mut(),
        MoveWrite {
            org_id,
            employee_id,
            actor_id,
            command_id: undo,
        },
        on,
        workplace,
    )
    .await
    .map_err(coded)
}
