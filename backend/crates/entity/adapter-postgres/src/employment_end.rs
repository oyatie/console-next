//! An exit's half of the assignment (UX-R3 STRUCT company-01, records-04):
//! the TERMINATE an exit records ends the person's live assignment the day
//! after their 마지막 근무일 (`valid_to` is exclusive, as on
//! `employment_heads`), so no 사업장 or 법인 counts them past it; reversing
//! the exit reopens it. ADR-004: this crate stays the one writer of
//! `employment_assignments`. The caller holds the employee row `FOR UPDATE`.

use console_kernel_core::KernelError;
use sqlx::PgConnection;
use time::Date;
use uuid::Uuid;

use crate::employment_hire::{Placed, insert_from, unit_placement};
use crate::employment_moves::{MoveWrite, open_workplace_entity};
use crate::employment_rows::{copy_with_end, supersede};

fn internal(error: sqlx::Error) -> KernelError {
    KernelError::internal(format!("employment assignment end failed: {error}"))
}

/// The first non-employed day after the stored 마지막 근무일.
#[must_use]
pub fn retirement_date(last_day: Date) -> Date {
    last_day.next_day().unwrap_or(last_day)
}

/// End every live assignment that runs past `last_day` on the day after it.
/// An open row is closed in place (`valid_to` is set once, 0259); a row that
/// already ends later is shortened by supersede + copy. Returns the rows ended.
///
/// # Errors
/// Internal on a database fault.
pub async fn end_on_exit_in_tx(
    conn: &mut PgConnection,
    w: MoveWrite,
    last_day: Date,
) -> Result<u64, KernelError> {
    let end = retirement_date(last_day);
    let rows: Vec<(Uuid, Option<Date>)> = sqlx::query_as(
        "SELECT id, valid_to FROM employment_assignments WHERE org_id = $1 AND employee_id = $2 \
         AND superseded_at IS NULL AND valid_from < $3 AND (valid_to IS NULL OR valid_to > $3) FOR UPDATE",
    )
    .bind(w.org_id)
    .bind(w.employee_id)
    .bind(end)
    .fetch_all(&mut *conn)
    .await
    .map_err(internal)?;
    for (id, until) in &rows {
        if until.is_none() {
            sqlx::query(
                "UPDATE employment_assignments SET valid_to = $3 WHERE org_id = $1 AND id = $2",
            )
            .bind(w.org_id)
            .bind(id)
            .bind(end)
            .execute(&mut *conn)
            .await
            .map_err(internal)?;
        } else {
            supersede(conn, w.org_id, *id).await?;
            let fresh = MoveWrite {
                command_id: Uuid::new_v4(),
                ..w
            };
            copy_with_end(conn, fresh, *id, Some(end)).await?;
        }
    }
    Ok(rows.len() as u64)
}

/// Reopen the rows [`end_on_exit_in_tx`] ended (those ending the day after
/// `last_day`): each is superseded by a copy that runs on, up to the next
/// assignment if one starts later. Returns the rows reopened.
///
/// # Errors
/// Internal on a database fault.
pub async fn reopen_on_exit_in_tx(
    conn: &mut PgConnection,
    w: MoveWrite,
    last_day: Date,
) -> Result<u64, KernelError> {
    let end = retirement_date(last_day);
    let rows: Vec<(Uuid, Option<Date>)> = sqlx::query_as(
        "SELECT a.id, (SELECT min(b.valid_from) FROM employment_assignments b WHERE b.org_id = a.org_id \
           AND b.employee_id = a.employee_id AND b.superseded_at IS NULL AND b.valid_from >= $3) \
         FROM employment_assignments a WHERE a.org_id = $1 AND a.employee_id = $2 \
           AND a.superseded_at IS NULL AND a.valid_to = $3 FOR UPDATE OF a",
    )
    .bind(w.org_id)
    .bind(w.employee_id)
    .bind(end)
    .fetch_all(&mut *conn)
    .await
    .map_err(internal)?;
    for (id, next) in &rows {
        supersede(conn, w.org_id, *id).await?;
        let fresh = MoveWrite {
            command_id: Uuid::new_v4(),
            ..w
        };
        copy_with_end(conn, fresh, *id, *next).await?;
    }
    Ok(rows.len() as u64)
}

/// A rehire's half (UX-R3 STRUCT): the exit ended the last assignment, so the
/// new period is placed again at the 사업장 its org unit sits in, from the
/// rehire date; `None` (미배치) when the unit has no 사업장.
///
/// # Errors
/// 422 `workplace_not_open`; 409 `employee_already_placed` when an
/// assignment still runs on `from`; internal on a database fault.
pub async fn rehire_in_tx(
    conn: &mut PgConnection,
    w: MoveWrite,
    unit: Uuid,
    from: Date,
) -> Result<Option<Placed>, KernelError> {
    let Some(at) = unit_placement(conn, w.org_id, unit).await? else {
        return Ok(None);
    };
    let entity = open_workplace_entity(conn, w.org_id, at.workplace_id, Some(from)).await?;
    let live: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM employment_assignments WHERE org_id = $1 AND employee_id = $2 \
           AND superseded_at IS NULL AND (valid_to IS NULL OR valid_to > $3))",
    )
    .bind(w.org_id)
    .bind(w.employee_id)
    .bind(from)
    .fetch_one(&mut *conn)
    .await
    .map_err(internal)?;
    if live {
        return Err(KernelError::conflict(
            "the employee still has a 법인 · 사업장 assignment on the rehire date",
        )
        .with_code("employee_already_placed"));
    }
    insert_from(conn, w, entity, at.workplace_id, from)
        .await
        .map(Some)
}
