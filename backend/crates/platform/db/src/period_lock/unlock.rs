//! BW-15 unlock and re-lock writes (decisions #8b). Rows stay append-only: an
//! unlock is the one-shot UPDATE of a lock row (0107 trigger), and a re-lock —
//! by the scheduler, or by an unlock of a lock whose window already expired —
//! appends a successor row for the same window.
//!
//! Who may unlock (step-up, second person) is decided by the caller; these
//! functions only write. Each runs in the caller's org-armed transaction.

use console_kernel_core::KernelError;
use sqlx::{Postgres, Row, Transaction};
use time::{Date, OffsetDateTime};
use uuid::Uuid;

use super::{PeriodLockDomain, lock_period_lock_key};

/// One `period_locks` row as the unlock path reads it.
#[derive(Debug, Clone)]
pub struct LockRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub domain: String,
    pub period_start: Date,
    pub period_end: Date,
    pub unlocked_at: Option<OffsetDateTime>,
    /// `period_lock_effective()`: never unlocked, or the window expired with
    /// no successor yet.
    pub effective: bool,
}

/// What the unlock writes.
#[derive(Debug, Clone)]
pub struct UnlockWrite<'a> {
    pub unlocked_by: Uuid,
    /// The second person; `None` for a sole-holder unlock.
    pub approved_by: Option<Uuid>,
    pub step_up_assertion_id: Uuid,
    pub reason_code: &'a str,
    pub note: Option<&'a str>,
    pub relock_at: OffsetDateTime,
    pub review_required: bool,
}

macro_rules! lock_columns {
    () => {
        "id, org_id, domain, period_start, period_end, unlocked_at, \
                            period_lock_effective(period_locks) AS effective"
    };
}

fn lock_row(row: &sqlx::postgres::PgRow) -> Result<LockRow, sqlx::Error> {
    Ok(LockRow {
        id: row.try_get("id")?,
        org_id: row.try_get("org_id")?,
        domain: row.try_get("domain")?,
        period_start: row.try_get("period_start")?,
        period_end: row.try_get("period_end")?,
        unlocked_at: row.try_get("unlocked_at")?,
        effective: row.try_get("effective")?,
    })
}

/// Lock one `period_locks` row (`FOR UPDATE`) and read it.
pub async fn load_lock_for_update(
    tx: &mut Transaction<'_, Postgres>,
    lock_id: Uuid,
) -> Result<Option<LockRow>, sqlx::Error> {
    let row = sqlx::query(concat!(
        "SELECT ",
        lock_columns!(),
        " FROM period_locks WHERE id = $1 FOR UPDATE"
    ))
    .bind(lock_id)
    .fetch_optional(tx.as_mut())
    .await?;
    row.as_ref().map(lock_row).transpose()
}

/// Append the successor of an expired unlock: the same window, locked again,
/// with the original reason and no locker (the system re-locked it). Takes the
/// per-domain lock key first, like every lock CREATE, so the successor orders
/// strictly against gated writes and against another appender.
///
/// `None` when the window already has its successor. Two re-lock runners
/// (api and worker replicas) can both read the same expired row: one whose
/// statement snapshot predates the other's commit locks the row after that
/// commit (`SKIP LOCKED` no longer skips it, and the row itself did not
/// change). The insert re-checks `period_lock_effective` under the key with a
/// fresh statement snapshot, so the second runner appends nothing.
pub async fn append_successor_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    expired: &LockRow,
) -> Result<Option<Uuid>, sqlx::Error> {
    let domain = PeriodLockDomain::parse(&expired.domain)
        .map_err(|error| sqlx::Error::Protocol(error.message))?;
    lock_period_lock_key(tx, domain, expired.org_id).await?;
    sqlx::query_scalar(
        "INSERT INTO period_locks (org_id, domain, period_start, period_end, reason, reason_code) \
         SELECT org_id, domain, period_start, period_end, reason, reason_code \
         FROM period_locks p WHERE p.id = $1 AND period_lock_effective(p) \
         RETURNING id",
    )
    .bind(expired.id)
    .fetch_optional(tx.as_mut())
    .await
}

/// Unlock the window of `lock_id`. The window's newest row is the one that
/// counts (a re-lock appends rows, so the client may hold an older id): when
/// it was never unlocked it is unlocked; when its unlock window expired, the
/// successor is appended and unlocked. Returns the id of the row unlocked.
///
/// # Errors
/// 404 for an unknown lock; 409 when the window is open (unlocked, its window
/// not expired); internal on SQL.
pub async fn unlock_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    lock_id: Uuid,
    write: &UnlockWrite<'_>,
) -> Result<Uuid, KernelError> {
    let named = load_lock_for_update(tx, lock_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| KernelError::not_found("period lock was not found"))?;
    let head = sqlx::query(concat!(
        "SELECT ",
        lock_columns!(),
        " FROM period_locks \
         WHERE domain = $1 AND period_start = $2 AND period_end = $3 \
         ORDER BY locked_at DESC LIMIT 1 FOR UPDATE"
    ))
    .bind(&named.domain)
    .bind(named.period_start)
    .bind(named.period_end)
    .fetch_one(tx.as_mut())
    .await
    .and_then(|row| lock_row(&row))
    .map_err(internal)?;
    let target = match (head.unlocked_at, head.effective) {
        (None, _) => head.id,
        (Some(_), true) => append_successor_in_tx(tx, &head)
            .await
            .map_err(internal)?
            .ok_or_else(|| {
                KernelError::conflict("period lock was re-locked concurrently; try again")
                    .with_code("period_lock_changed")
            })?,
        (Some(_), false) => {
            return Err(KernelError::conflict("period lock is already unlocked"));
        }
    };
    // The governed unlock may reopen a month an org 근태 close references: it
    // names the row it unlocks for the kept 0188 guard (migration
    // 20261013142447372), which still refuses any other unlock of such a lock.
    // Goes with that guard's contract (pending/20261013142447372_*).
    sqlx::query("SELECT set_config('app.period_unlock', $1, true)")
        .bind(target.to_string())
        .execute(tx.as_mut())
        .await
        .map_err(internal)?;
    sqlx::query(
        "UPDATE period_locks SET unlocked_at = now(), unlocked_by = $2, unlock_reason = $3, \
                unlock_reason_code = $4, relock_at = $5, unlock_approved_by = $6, \
                unlock_step_up_assertion_id = $7, unlock_review_required = $8 \
         WHERE id = $1",
    )
    .bind(target)
    .bind(write.unlocked_by)
    .bind(write.note)
    .bind(write.reason_code)
    .bind(write.relock_at)
    .bind(write.approved_by)
    .bind(write.step_up_assertion_id)
    .bind(write.review_required)
    .execute(tx.as_mut())
    .await
    .map_err(internal)?;
    Ok(target)
}

/// Re-lock every expired unlock window of the armed tenant: append one
/// successor per row whose `relock_at` has passed. Rows another re-locker holds
/// are skipped (`SKIP LOCKED`); they are done by that one. Returns
/// `(expired row, successor)` pairs for the audit.
pub async fn relock_expired_in_tx(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<Vec<(Uuid, Uuid)>, sqlx::Error> {
    let rows = sqlx::query(concat!(
        "SELECT ",
        lock_columns!(),
        " FROM period_locks \
         WHERE unlocked_at IS NOT NULL AND period_lock_effective(period_locks) \
         ORDER BY locked_at FOR UPDATE SKIP LOCKED"
    ))
    .fetch_all(tx.as_mut())
    .await?;
    let mut relocked = Vec::with_capacity(rows.len());
    for row in &rows {
        let expired = lock_row(row)?;
        if let Some(successor) = append_successor_in_tx(tx, &expired).await? {
            relocked.push((expired.id, successor));
        }
    }
    Ok(relocked)
}

fn internal(error: sqlx::Error) -> KernelError {
    KernelError::internal(format!("period unlock failed: {error}"))
}
