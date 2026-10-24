//! `EmploymentAssignmentPort`, LIFE's half (ED §3.9, delivery-plan E-S3b):
//! the calls hr makes inside ITS OWN lifecycle transaction (ADR-004: this
//! crate stays the one writer of `employment_assignments`).
//!
//! - [`move_in_tx`] splits the employee's assignment on the event date: the
//!   covering row ends there (`valid_to` is exclusive) and a row at the new
//!   법인 · 사업장 starts. 전근 (`TRANSFER`, same 법인) and 전적
//!   (`GROUP_TRANSFER`, another 법인) differ only in the cause and the
//!   `group_transfer_id`; which move is lawful is hr's decision.
//! - [`undo_move_in_tx`] reverses the move of the employee's latest event
//!   when it is rescinded or corrected: the row the move started and the row
//!   it ended are superseded, and one row spanning both takes their place.
//!
//! The caller holds the employee row `FOR UPDATE`, which serialises every
//! writer; the no-overlap trigger is the backstop.

use console_kernel_core::KernelError;
use sqlx::{PgConnection, Row};
use time::Date;
use uuid::Uuid;

use crate::employment_rows::{copy_with_end, supersede};

/// Who and which hr command a write belongs to (the row's `command_id`).
#[derive(Debug, Clone, Copy)]
pub struct MoveWrite {
    pub org_id: Uuid,
    pub employee_id: Uuid,
    pub actor_id: Uuid,
    pub command_id: Uuid,
}

/// Where a move lands. `group_transfer_id` set ⇒ cause `GROUP_TRANSFER`.
#[derive(Debug, Clone, Copy)]
pub struct MoveTarget {
    pub legal_entity_id: Uuid,
    pub workplace_id: Uuid,
    pub group_transfer_id: Option<Uuid>,
}

/// One live assignment row.
#[derive(Debug, Clone, Copy)]
pub struct Placement {
    pub id: Uuid,
    pub legal_entity_id: Option<Uuid>,
    pub workplace_id: Option<Uuid>,
    pub valid_from: Date,
    pub valid_to: Option<Date>,
}

fn internal(error: sqlx::Error) -> KernelError {
    KernelError::internal(format!("employment assignment write failed: {error}"))
}

fn placement(row: &sqlx::postgres::PgRow) -> Result<Placement, sqlx::Error> {
    Ok(Placement {
        id: row.try_get("id")?,
        legal_entity_id: row.try_get("legal_entity_id")?,
        workplace_id: row.try_get("workplace_id")?,
        valid_from: row.try_get("valid_from")?,
        valid_to: row.try_get("valid_to")?,
    })
}

/// The live assignment covering `on`, locked.
///
/// # Errors
/// Internal on a database fault.
pub async fn placement_on(
    conn: &mut PgConnection,
    org: Uuid,
    employee: Uuid,
    on: Date,
) -> Result<Option<Placement>, KernelError> {
    let row = sqlx::query(
        "SELECT id, legal_entity_id, workplace_id, valid_from, valid_to FROM employment_assignments WHERE org_id = $1 AND employee_id = $2 \
         AND superseded_at IS NULL AND valid_from <= $3 AND (valid_to IS NULL OR valid_to > $3) FOR UPDATE",
    )
    .bind(org)
    .bind(employee)
    .bind(on)
    .fetch_optional(&mut *conn)
    .await
    .map_err(internal)?;
    row.as_ref().map(placement).transpose().map_err(internal)
}

/// The 법인 of an open 사업장 (neither closed nor voided, nor its 법인).
///
/// # Errors
/// 422 `workplace_not_open` on `to_workplace_id`; internal on a database fault.
pub async fn open_workplace_entity(
    conn: &mut PgConnection,
    org: Uuid,
    workplace: Uuid,
    on: Option<Date>,
) -> Result<Uuid, KernelError> {
    let entity: Option<(Uuid, Option<Date>)> = sqlx::query_as(
        "SELECT w.legal_entity_id, entity_workplace_opens_on(w.id) FROM workplaces w JOIN legal_entities e \
           ON e.org_id = w.org_id AND e.id = w.legal_entity_id \
         WHERE w.org_id = $1 AND w.id = $2 AND w.voided_at IS NULL AND w.closed_on IS NULL \
           AND e.voided_at IS NULL AND e.closed_on IS NULL",
    )
    .bind(org)
    .bind(workplace)
    .fetch_optional(&mut *conn)
    .await
    .map_err(internal)?;
    let (entity, opened) = entity.ok_or_else(|| {
        KernelError::validation("to_workplace_id must be an open 사업장")
            .with_code("workplace_not_open")
    })?;
    if on.zip(opened).is_some_and(|(on, opened)| on < opened) {
        return Err(KernelError::validation(
            "the workplace or its legal entity was not open on the placement date",
        )
        .with_code("workplace_not_open_on_date"));
    }
    Ok(entity)
}

/// The 법인's exact name on `on` when it has a confirmed, non-voided
/// registration open on the date; no imported label is evidence.
///
/// # Errors
/// Internal on a database fault.
pub async fn entity_label(
    conn: &mut PgConnection,
    org: Uuid,
    entity: Uuid,
    on: Date,
) -> Result<Option<String>, KernelError> {
    sqlx::query_scalar(
        "SELECT r.name FROM legal_entities e \
         JOIN LATERAL (SELECT name FROM legal_entity_revisions x \
           WHERE x.org_id = $1 AND x.legal_entity_id = e.id AND x.effective_from <= $3 \
           ORDER BY x.effective_from DESC, x.version DESC LIMIT 1) r ON true \
         WHERE e.org_id = $1 AND e.id = $2 \
           AND EXISTS (SELECT 1 FROM business_registrations h \
             WHERE h.org_id = $1 AND h.legal_entity_id = e.id AND NOT h.needs_confirmation \
               AND h.voided_at IS NULL AND (h.closed_on IS NULL OR h.closed_on > $3))",
    )
    .bind(org)
    .bind(entity)
    .bind(on)
    .fetch_optional(&mut *conn)
    .await
    .map_err(internal)
}

/// The 사업장 an org unit sits at today: its own open placement, else its
/// nearest placed ancestor's (a 부서 under a 사업장's SITE unit has no
/// placement of its own; UX-R1 PLACEMENT move-01/move-02).
///
/// # Errors
/// Internal on a database fault.
pub async fn unit_workplace(
    conn: &mut PgConnection,
    org: Uuid,
    unit: Uuid,
) -> Result<Option<Uuid>, KernelError> {
    Ok(crate::employment_hire::unit_placement(conn, org, unit)
        .await?
        .map(|p| p.workplace_id))
}

async fn later_exists(
    conn: &mut PgConnection,
    w: MoveWrite,
    after: Date,
    except: Option<Uuid>,
) -> Result<bool, KernelError> {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM employment_assignments WHERE org_id = $1 AND employee_id = $2 \
         AND superseded_at IS NULL AND valid_from > $3 AND id IS DISTINCT FROM $4)",
    )
    .bind(w.org_id)
    .bind(w.employee_id)
    .bind(after)
    .bind(except)
    .fetch_one(&mut *conn)
    .await
    .map_err(internal)
}

fn later_refusal() -> KernelError {
    KernelError::conflict(
        "the employee has a later 법인 · 사업장 assignment; end it before this change",
    )
    .with_code("assignment_after_move")
}

/// Move the employee to `to` from `on`, splitting the covering assignment.
/// Returns the row the move ended.
///
/// # Errors
/// 409 `employee_unassigned` (no 법인 · 사업장 recorded on `on`), 409
/// `assignment_after_move` (a later assignment exists), 409
/// `assignment_starts_on_move_date` (the placement starts that day: correct
/// it instead); internal on a database fault.
pub async fn move_in_tx(
    conn: &mut PgConnection,
    w: MoveWrite,
    to: MoveTarget,
    on: Date,
) -> Result<Placement, KernelError> {
    let entity = open_workplace_entity(conn, w.org_id, to.workplace_id, Some(on)).await?;
    if entity != to.legal_entity_id {
        return Err(
            KernelError::validation("the workplace belongs to another legal entity")
                .with_code("workplace_of_other_entity"),
        );
    }
    if later_exists(conn, w, on, None).await? {
        return Err(later_refusal());
    }
    let covering = placement_on(conn, w.org_id, w.employee_id, on)
        .await?
        .filter(|p| p.legal_entity_id.is_some())
        .ok_or_else(|| {
            KernelError::conflict("record the employee's 법인 · 사업장 before moving them")
                .with_code("employee_unassigned")
        })?;
    if covering.valid_from == on {
        return Err(KernelError::conflict(
            "the employee's 법인 · 사업장 placement starts that day; correct it instead of moving them",
        )
        .with_code("assignment_starts_on_move_date"));
    }
    if covering.valid_to.is_none() {
        sqlx::query(
            "UPDATE employment_assignments SET valid_to = $3 WHERE org_id = $1 AND id = $2",
        )
        .bind(w.org_id)
        .bind(covering.id)
        .bind(on)
        .execute(&mut *conn)
        .await
        .map_err(internal)?;
    } else {
        // An end already set (an exit) stays with the moved row; the covering
        // row is shortened by copy, under a fresh command id (one row per
        // command and employee).
        supersede(conn, w.org_id, covering.id).await?;
        let split = MoveWrite {
            command_id: Uuid::new_v4(),
            ..w
        };
        copy_with_end(conn, split, covering.id, Some(on)).await?;
    }
    sqlx::query(
        "INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, workplace_id, \
           valid_from, valid_to, cause, group_transfer_id, actor_id, command_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(w.org_id)
    .bind(w.employee_id)
    .bind(to.legal_entity_id)
    .bind(to.workplace_id)
    .bind(on)
    .bind(covering.valid_to)
    .bind(if to.group_transfer_id.is_some() {
        "GROUP_TRANSFER"
    } else {
        "TRANSFER"
    })
    .bind(to.group_transfer_id)
    .bind(w.actor_id)
    .bind(w.command_id)
    .execute(&mut *conn)
    .await
    .map_err(internal)?;
    Ok(covering)
}

/// Reverse the move to `workplace` that started on `on` (the employee's
/// latest change, being rescinded or corrected); `w.command_id` is the
/// undoing command. The moved row and the row it ended are superseded and one
/// row spanning both takes their place. Nothing happens when the live row on
/// `on` is not that move (the placement was corrected since).
///
/// # Errors
/// 409 `assignment_after_move` when a later assignment starts after the moved
/// row; internal on a database fault.
pub async fn undo_move_in_tx(
    conn: &mut PgConnection,
    w: MoveWrite,
    on: Date,
    workplace: Uuid,
) -> Result<(), KernelError> {
    let moved: Option<(Uuid, Option<Date>)> = sqlx::query_as(
        "SELECT id, valid_to FROM employment_assignments WHERE org_id = $1 AND employee_id = $2 \
         AND superseded_at IS NULL AND valid_from = $3 AND workplace_id = $4 \
         AND cause IN ('TRANSFER', 'GROUP_TRANSFER') FOR UPDATE",
    )
    .bind(w.org_id)
    .bind(w.employee_id)
    .bind(on)
    .bind(workplace)
    .fetch_optional(&mut *conn)
    .await
    .map_err(internal)?;
    let Some((moved, until)) = moved else {
        return Ok(());
    };
    if later_exists(conn, w, on, Some(moved)).await? {
        return Err(later_refusal());
    }
    let ended: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM employment_assignments WHERE org_id = $1 AND employee_id = $2 \
         AND superseded_at IS NULL AND valid_to = $3 FOR UPDATE",
    )
    .bind(w.org_id)
    .bind(w.employee_id)
    .bind(on)
    .fetch_optional(&mut *conn)
    .await
    .map_err(internal)?;
    let Some(ended) = ended else {
        return Ok(());
    };
    supersede(conn, w.org_id, moved).await?;
    supersede(conn, w.org_id, ended).await?;
    copy_with_end(conn, w, ended, until).await
}
