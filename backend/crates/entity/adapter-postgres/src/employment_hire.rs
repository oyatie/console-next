//! A person's first 법인 · 사업장 assignment, written inside the caller's own
//! transaction (registration MR-22, import MR-7; ADR-004: this crate stays the
//! one writer of `employment_assignments`).
//!
//! - [`unit_placement`] finds the 법인 · 사업장 an org unit sits in: its own
//!   open placement, else its nearest ancestor's (a 부서 or 팀 under the
//!   사업장's SITE unit).
//! - [`unit_contradicts`] names the 사업장 a placement would contradict.
//! - [`open_workplaces`] names every open 사업장, for an import's 사업장 column.
//! - [`hire_in_tx`] writes the first assignment from the hire date, once.
//! - [`withdraw_voided_in_tx`] supersedes every live one of a voided record.
//!
//! The caller holds the employee row (it has just inserted it), which
//! serialises writers; the no-overlap trigger is the backstop.

use console_kernel_core::KernelError;
use sqlx::PgConnection;
use time::Date;
use uuid::Uuid;

use crate::employment_moves::{MoveWrite, open_workplace_entity};

/// Where a person is placed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Placed {
    pub legal_entity_id: Uuid,
    pub workplace_id: Uuid,
}

fn internal(error: sqlx::Error) -> KernelError {
    KernelError::internal(format!("employment assignment write failed: {error}"))
}

/// The 법인 · 사업장 of `unit` today: the open placement of the unit or of
/// its nearest ancestor that has one. `None` when no ancestor is placed. The
/// one resolver (0319 `placement_unit_workplaces`): registration, binding,
/// 전보 and the placement checks all judge a unit through it.
///
/// # Errors
/// Internal on a database fault.
pub async fn unit_placement(
    conn: &mut PgConnection,
    org: Uuid,
    unit: Uuid,
) -> Result<Option<Placed>, KernelError> {
    // the resolver reads every unit head of the tenant; scope it to
    // the chain if a tenant's org tree grows past a few thousand units.
    let found: Option<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT legal_entity_id, workplace_id FROM placement_unit_workplaces($1, $2)",
    )
    .bind(org)
    .bind(unit)
    .fetch_optional(&mut *conn)
    .await
    .map_err(internal)?;
    Ok(found.map(|(legal_entity_id, workplace_id)| Placed {
        legal_entity_id,
        workplace_id,
    }))
}

/// The 사업장 the employee's 부서 sits in today when it is not `workplace`:
/// placing them there would contradict the org chart (org-01). `None` when
/// they agree, or the employee is in no placed 부서.
///
/// # Errors
/// Internal on a database fault.
pub async fn unit_contradicts(
    conn: &mut PgConnection,
    org: Uuid,
    employee: Uuid,
    workplace: Uuid,
) -> Result<Option<Uuid>, KernelError> {
    let unit: Option<Option<Uuid>> =
        sqlx::query_scalar("SELECT org_unit_id FROM employees WHERE org_id = $1 AND id = $2")
            .bind(org)
            .bind(employee)
            .fetch_optional(&mut *conn)
            .await
            .map_err(internal)?;
    let Some(unit) = unit.flatten() else {
        return Ok(None);
    };
    Ok(unit_placement(conn, org, unit)
        .await?
        .map(|p| p.workplace_id)
        .filter(|at| *at != workplace))
}

/// Every open 사업장 (neither it nor its 법인 closed or voided) with its
/// current name, for matching a 사업장 column of an import (MR-7).
///
/// # Errors
/// Internal on a database fault.
pub async fn open_workplaces(
    conn: &mut PgConnection,
    org: Uuid,
) -> Result<Vec<(String, Uuid)>, KernelError> {
    sqlx::query_as(
        "SELECT r.name, w.id FROM workplaces w \
         JOIN legal_entities e ON e.org_id = w.org_id AND e.id = w.legal_entity_id \
         JOIN LATERAL (SELECT name FROM workplace_revisions x WHERE x.org_id = w.org_id \
           AND x.workplace_id = w.id ORDER BY x.effective_from DESC, x.version DESC LIMIT 1) r ON true \
         WHERE w.org_id = $1 AND w.voided_at IS NULL AND w.closed_on IS NULL \
           AND e.voided_at IS NULL AND e.closed_on IS NULL",
    )
    .bind(org)
    .fetch_all(&mut *conn)
    .await
    .map_err(internal)
}

/// Initial placement starts at hire or the foundation objects' opening, whichever is later.
///
/// # Errors
/// Internal on a database fault.
pub async fn initial_placement_start(
    conn: &mut PgConnection,
    workplace: Uuid,
    hire: Date,
) -> Result<Date, KernelError> {
    let opened: Option<Date> = sqlx::query_scalar("SELECT entity_workplace_opens_on($1)")
        .bind(workplace)
        .fetch_one(conn)
        .await
        .map_err(internal)?;
    Ok(opened.map_or(hire, |opened| hire.max(opened)))
}

/// Place the person at the open 사업장 `workplace` from `from`, open-ended.
/// The cause is `SETUP_BIND` while the tenant is in SETUP, `HIRE` after.
///
/// # Errors
/// 422 `workplace_not_open`; 409 `employee_already_placed` when the person
/// already has an assignment; internal on a database fault.
pub async fn hire_in_tx(
    conn: &mut PgConnection,
    w: MoveWrite,
    workplace: Uuid,
    from: Date,
) -> Result<Placed, KernelError> {
    let entity = open_workplace_entity(conn, w.org_id, workplace, Some(from)).await?;
    let placed: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM employment_assignments \
         WHERE org_id = $1 AND employee_id = $2 AND superseded_at IS NULL)",
    )
    .bind(w.org_id)
    .bind(w.employee_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(internal)?;
    if placed {
        return Err(
            KernelError::conflict("the employee already has a 법인 · 사업장 assignment")
                .with_code("employee_already_placed"),
        );
    }
    insert_from(conn, w, entity, workplace, from).await
}

/// One open-ended assignment from `from` (`SETUP_BIND` in SETUP, `HIRE` after).
pub(crate) async fn insert_from(
    conn: &mut PgConnection,
    w: MoveWrite,
    entity: Uuid,
    workplace: Uuid,
    from: Date,
) -> Result<Placed, KernelError> {
    sqlx::query(
        "INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, workplace_id, \
           valid_from, cause, actor_id, command_id) \
         SELECT $1, $2, $3, $4, $5, \
           CASE WHEN EXISTS (SELECT 1 FROM tenant_phase WHERE org_id = $1 AND phase = 'SETUP') \
                THEN 'SETUP_BIND' ELSE 'HIRE' END, $6, $7",
    )
    .bind(w.org_id)
    .bind(w.employee_id)
    .bind(entity)
    .bind(workplace)
    .bind(from)
    .bind(w.actor_id)
    .bind(w.command_id)
    .execute(&mut *conn)
    .await
    .map_err(internal)?;
    Ok(Placed {
        legal_entity_id: entity,
        workplace_id: workplace,
    })
}

/// A voided registration (MR-26) never held its 법인 · 사업장: every live
/// assignment of the person is superseded, so no headcount, roster or
/// "people still placed here" check counts it. Returns how many.
///
/// # Errors
/// Internal on a database fault.
pub async fn withdraw_voided_in_tx(
    conn: &mut PgConnection,
    org: Uuid,
    employee: Uuid,
) -> Result<u64, KernelError> {
    sqlx::query(
        "UPDATE employment_assignments SET superseded_at = now() \
         WHERE org_id = $1 AND employee_id = $2 AND superseded_at IS NULL",
    )
    .bind(org)
    .bind(employee)
    .execute(&mut *conn)
    .await
    .map(|done| done.rows_affected())
    .map_err(internal)
}
