//! BW-15 unlock requests waiting for their second person
//! (`period_unlock_requests`, migration 0271). One open request per lock: a new
//! request supersedes the open one, so a request nobody approves never blocks
//! the next. The approver performs the unlock (see [`super::unlock`]); the
//! second person may refuse it instead, with a note (migration 0356).

use sqlx::{Postgres, Row, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

/// One unlock request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnlockRequest {
    pub id: Uuid,
    pub lock_id: Uuid,
    pub requested_by: Uuid,
    pub reason_code: String,
    pub reason_note: Option<String>,
    pub relock_at: OffsetDateTime,
    pub step_up_assertion_id: Uuid,
    pub requested_at: OffsetDateTime,
}

/// A request to open.
#[derive(Debug, Clone)]
pub struct NewUnlockRequest<'a> {
    pub org_id: Uuid,
    pub lock_id: Uuid,
    pub requested_by: Uuid,
    pub reason_code: &'a str,
    pub reason_note: Option<&'a str>,
    pub relock_at: OffsetDateTime,
    pub step_up_assertion_id: Uuid,
}

macro_rules! request_columns {
    () => {
        "id, lock_id, requested_by, reason_code, reason_note, relock_at, \
                       step_up_assertion_id, requested_at"
    };
}

fn request_row(row: &sqlx::postgres::PgRow) -> Result<UnlockRequest, sqlx::Error> {
    Ok(UnlockRequest {
        id: row.try_get("id")?,
        lock_id: row.try_get("lock_id")?,
        requested_by: row.try_get("requested_by")?,
        reason_code: row.try_get("reason_code")?,
        reason_note: row.try_get("reason_note")?,
        relock_at: row.try_get("relock_at")?,
        step_up_assertion_id: row.try_get("step_up_assertion_id")?,
        requested_at: row.try_get("requested_at")?,
    })
}

/// Open a request, superseding the lock's open one (if any). Returns the new
/// request and the id of the superseded one.
pub async fn open_unlock_request_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    new: &NewUnlockRequest<'_>,
) -> Result<(UnlockRequest, Option<Uuid>), sqlx::Error> {
    let superseded: Option<Uuid> = sqlx::query_scalar(
        "UPDATE period_unlock_requests \
         SET outcome = 'SUPERSEDED', decided_by = $2, decided_at = now() \
         WHERE lock_id = $1 AND outcome IS NULL RETURNING id",
    )
    .bind(new.lock_id)
    .bind(new.requested_by)
    .fetch_optional(tx.as_mut())
    .await?;
    let row = sqlx::query(concat!(
        "INSERT INTO period_unlock_requests \
             (org_id, lock_id, requested_by, reason_code, reason_note, relock_at, \
              step_up_assertion_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ",
        request_columns!()
    ))
    .bind(new.org_id)
    .bind(new.lock_id)
    .bind(new.requested_by)
    .bind(new.reason_code)
    .bind(new.reason_note)
    .bind(new.relock_at)
    .bind(new.step_up_assertion_id)
    .fetch_one(tx.as_mut())
    .await?;
    Ok((request_row(&row)?, superseded))
}

/// The lock's open request, locked (`FOR UPDATE`).
pub async fn load_open_unlock_request_for_update(
    tx: &mut Transaction<'_, Postgres>,
    lock_id: Uuid,
) -> Result<Option<UnlockRequest>, sqlx::Error> {
    let row = sqlx::query(concat!(
        "SELECT ",
        request_columns!(),
        " FROM period_unlock_requests \
         WHERE lock_id = $1 AND outcome IS NULL FOR UPDATE"
    ))
    .bind(lock_id)
    .fetch_optional(tx.as_mut())
    .await?;
    row.as_ref().map(request_row).transpose()
}

/// Mark the request approved by `approver` (the DB refuses the requester).
pub async fn approve_unlock_request_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    request_id: Uuid,
    approver: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE period_unlock_requests \
         SET outcome = 'APPROVED', decided_by = $2, decided_at = now() WHERE id = $1",
    )
    .bind(request_id)
    .bind(approver)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

/// Mark the request refused by `decider` with `note` (the DB refuses the requester).
pub async fn reject_unlock_request_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    request_id: Uuid,
    decider: Uuid,
    note: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE period_unlock_requests \
         SET outcome = 'REJECTED', decided_by = $2, decided_at = now(), decision_note = $3 \
         WHERE id = $1",
    )
    .bind(request_id)
    .bind(decider)
    .bind(note)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

/// A lock's latest unlock request with its decision, as the lock list shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnlockRequestRecord {
    pub request: UnlockRequest,
    pub requested_by_name: Option<String>,
    pub outcome: Option<String>,
    pub decided_by: Option<Uuid>,
    pub decided_by_name: Option<String>,
    pub decided_at: Option<OffsetDateTime>,
    pub decision_note: Option<String>,
}

/// The latest unlock request of each of `lock_ids` (RLS-scoped; names of
/// removed accounts read as none).
pub async fn latest_unlock_requests_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    lock_ids: &[Uuid],
) -> Result<Vec<UnlockRequestRecord>, sqlx::Error> {
    let rows = sqlx::query(concat!(
        "SELECT DISTINCT ON (lock_id) ",
        request_columns!(),
        ", outcome, decided_by, decided_at, decision_note, \
         (SELECT u.display_name FROM users u WHERE u.id = r.requested_by) AS requested_by_name, \
         (SELECT u.display_name FROM users u WHERE u.id = r.decided_by) AS decided_by_name \
         FROM period_unlock_requests r WHERE lock_id = ANY($1) \
         ORDER BY lock_id, requested_at DESC, id DESC"
    ))
    .bind(lock_ids)
    .fetch_all(tx.as_mut())
    .await?;
    rows.iter()
        .map(|row| {
            Ok(UnlockRequestRecord {
                request: request_row(row)?,
                requested_by_name: row.try_get("requested_by_name")?,
                outcome: row.try_get("outcome")?,
                decided_by: row.try_get("decided_by")?,
                decided_by_name: row.try_get("decided_by_name")?,
                decided_at: row.try_get("decided_at")?,
                decision_note: row.try_get("decision_note")?,
            })
        })
        .collect()
}
