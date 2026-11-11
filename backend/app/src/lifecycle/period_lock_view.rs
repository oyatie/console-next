//! A period lock as the API returns it, and the reads that build it. Moved out
//! of `period_locks.rs` under the 300-line cap; BW-15 adds the display names of
//! who locked, unlocked and approved, so no screen shows a bare user id.

use serde::Serialize;
use sqlx::Row;
use time::{Date, OffsetDateTime};
use uuid::Uuid;

use console_platform_authz::Principal;
use console_platform_db::period_lock::latest_unlock_requests_in_tx;
use console_settings_adapter_postgres::resolve_in_tx;

use super::LifecycleError;
use super::period_unlock::{SETTING_KEYS, request_status};
use super::unlock_decision::decider_stands;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PeriodLockResponse {
    id: Uuid,
    pub(super) domain: String,
    pub(super) period_start: String,
    pub(super) period_end: String,
    reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    locked_by: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    locked_by_name: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    locked_at: OffsetDateTime,
    #[serde(skip_serializing_if = "Option::is_none")]
    unlocked_by: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unlocked_by_name: Option<String>,
    #[serde(
        with = "time::serde::rfc3339::option",
        skip_serializing_if = "Option::is_none"
    )]
    unlocked_at: Option<OffsetDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unlock_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unlock_reason_code: Option<String>,
    #[serde(
        with = "time::serde::rfc3339::option",
        skip_serializing_if = "Option::is_none"
    )]
    relock_at: Option<OffsetDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unlock_approved_by: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unlock_approved_by_name: Option<String>,
    unlock_review_required: bool,
    /// In force now: never unlocked, or its unlock window has expired.
    active: bool,
    /// The latest unlock request on this lock and its decision (BW-15).
    #[serde(skip_serializing_if = "Option::is_none")]
    unlock_request: Option<UnlockRequestView>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UnlockRequestView {
    id: Uuid,
    status: &'static str,
    requested_by: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    requested_by_name: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    requested_at: OffsetDateTime,
    reason_code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason_note: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    relock_at: OffsetDateTime,
    #[serde(skip_serializing_if = "Option::is_none")]
    decided_by: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    decided_by_name: Option<String>,
    #[serde(
        with = "time::serde::rfc3339::option",
        skip_serializing_if = "Option::is_none"
    )]
    decided_at: Option<OffsetDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    decision_note: Option<String>,
    /// The caller may approve or refuse it now (a pending request only).
    can_decide: bool,
}

/// Attach each lock's latest unlock request, and whether the caller may decide
/// it: the second-person decision runs only for requests still waiting.
pub(super) async fn attach_unlock_requests(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    principal: &Principal,
    locks: &mut [PeriodLockResponse],
) -> Result<(), LifecycleError> {
    let ids: Vec<Uuid> = locks.iter().map(|lock| lock.id).collect();
    let records = latest_unlock_requests_in_tx(tx, &ids).await?;
    let now = OffsetDateTime::now_utc();
    let pending =
        |outcome: Option<&str>, relock_at| request_status(outcome, relock_at, now) == "PENDING";
    let settings = if records
        .iter()
        .any(|r| pending(r.outcome.as_deref(), r.request.relock_at))
    {
        Some(resolve_in_tx(tx.as_mut(), principal.org_id, &SETTING_KEYS, None, now).await?)
    } else {
        None
    };
    for record in records {
        let status = request_status(record.outcome.as_deref(), record.request.relock_at, now);
        let can_decide = match (status, &settings) {
            ("PENDING", Some(settings)) => {
                match decider_stands(tx, principal, &record.request, settings).await {
                    Ok(_) => true,
                    Err(refused) if refused.status == axum::http::StatusCode::FORBIDDEN => false,
                    Err(error) => return Err(error),
                }
            }
            _ => false,
        };
        let request = record.request;
        if let Some(lock) = locks.iter_mut().find(|lock| lock.id == request.lock_id) {
            lock.unlock_request = Some(UnlockRequestView {
                id: request.id,
                status,
                requested_by: request.requested_by,
                requested_by_name: record.requested_by_name,
                requested_at: request.requested_at,
                reason_code: request.reason_code,
                reason_note: request.reason_note,
                relock_at: request.relock_at,
                decided_by: record.decided_by,
                decided_by_name: record.decided_by_name,
                decided_at: record.decided_at,
                decision_note: record.decision_note,
                can_decide,
            });
        }
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub(super) struct PeriodLockListResponse {
    pub(super) items: Vec<PeriodLockResponse>,
}

fn period_lock_from_row(row: &sqlx::postgres::PgRow) -> Result<PeriodLockResponse, LifecycleError> {
    let period_start: Date = row.try_get("period_start")?;
    let period_end: Date = row.try_get("period_end")?;
    Ok(PeriodLockResponse {
        id: row.try_get("id")?,
        domain: row.try_get("domain")?,
        period_start: period_start.to_string(),
        period_end: period_end.to_string(),
        // 0252 made reason a nullable note beside reason_code; the wire keeps
        // the string ("" when only a code was given) for existing readers.
        reason: Option::unwrap_or_default(row.try_get("reason")?),
        locked_by: row.try_get("locked_by")?,
        locked_by_name: row.try_get("locked_by_name")?,
        locked_at: row.try_get("locked_at")?,
        unlocked_by: row.try_get("unlocked_by")?,
        unlocked_by_name: row.try_get("unlocked_by_name")?,
        unlocked_at: row.try_get("unlocked_at")?,
        unlock_reason: row.try_get("unlock_reason")?,
        reason_code: row.try_get("reason_code")?,
        unlock_reason_code: row.try_get("unlock_reason_code")?,
        relock_at: row.try_get("relock_at")?,
        unlock_approved_by: row.try_get("unlock_approved_by")?,
        unlock_approved_by_name: row.try_get("unlock_approved_by_name")?,
        unlock_review_required: row.try_get("unlock_review_required")?,
        active: row.try_get("active")?,
        unlock_request: None,
    })
}

/// Every column [`period_lock_from_row`] reads. The names are RLS-scoped
/// lookups: a removed account reads as no name, never another tenant's user.
macro_rules! lock_columns {
    () => {
        "id, domain, period_start, period_end, reason, reason_code, \
     locked_by, locked_at, unlocked_by, unlocked_at, unlock_reason, unlock_reason_code, relock_at, \
     unlock_approved_by, unlock_review_required, period_lock_effective(period_locks) AS active, \
     (SELECT u.display_name FROM users u WHERE u.id = period_locks.locked_by) AS locked_by_name, \
     (SELECT u.display_name FROM users u WHERE u.id = period_locks.unlocked_by) AS unlocked_by_name, \
     (SELECT u.display_name FROM users u WHERE u.id = period_locks.unlock_approved_by) \
         AS unlock_approved_by_name"
    };
}

/// One lock as the API returns it (RLS-scoped).
pub(super) async fn load_period_lock(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    lock_id: Uuid,
) -> Result<PeriodLockResponse, LifecycleError> {
    let row = sqlx::query(concat!(
        "SELECT ",
        lock_columns!(),
        " FROM period_locks WHERE id = $1"
    ))
    .bind(lock_id)
    .fetch_one(tx.as_mut())
    .await?;
    period_lock_from_row(&row)
}

/// Lock history newest first; `active = Some(true)` keeps the locks in force.
pub(super) async fn list_locks(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    domain: Option<&str>,
    limit: i64,
    active: Option<bool>,
) -> Result<Vec<PeriodLockResponse>, LifecycleError> {
    let rows = sqlx::query(concat!(
        "SELECT ",
        lock_columns!(),
        " FROM period_locks \
         WHERE ($1::text IS NULL OR domain = $1) \
           AND ($3::bool IS NOT TRUE OR period_lock_effective(period_locks)) \
         ORDER BY locked_at DESC \
         LIMIT $2"
    ))
    .bind(domain)
    .bind(limit)
    .bind(active)
    .fetch_all(tx.as_mut())
    .await?;
    rows.iter().map(period_lock_from_row).collect()
}
