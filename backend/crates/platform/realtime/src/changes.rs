//! `resource_changes` reads: the per-transaction re-read on the listener's
//! own connection, the replay superset, the head cursor and the prune.

use console_kernel_core::OrgId;
use console_platform_db::with_org_conn;
use serde::Deserialize;
use sqlx::postgres::{PgListener, PgRow};
use sqlx::{PgPool, Row};
use time::OffsetDateTime;

use crate::RealtimeError;
use crate::filter::ChangeRow;

/// The NOTIFY channel `emit_resource_change()` (migration 0312) wakes.
pub const RESOURCE_CHANGED_CHANNEL: &str = "resource_changed";

/// `{org, tx}`: identical for every row of one transaction. `tx` is an xid8
/// in decimal text.
#[derive(Debug, Deserialize)]
pub(crate) struct ChangeWake {
    pub(crate) org: OrgId,
    pub(crate) tx: String,
}

fn change_row(row: &PgRow) -> Result<ChangeRow, sqlx::Error> {
    Ok(ChangeRow {
        seq: row.try_get("seq")?,
        resource_type: row.try_get("resource_type")?,
        resource_id: row.try_get("resource_id")?,
        branch_id: row.try_get("branch_id")?,
        ver: row.try_get("ver")?,
    })
}

/// The woken transaction's rows, read on the listener's dedicated connection
/// so a storm never waits on the REST pool (spec F9). That connection never
/// returns to a pool, so a session-level `app.current_org` cannot leak into a
/// request; every wake re-arms it for its own tenant before the read.
pub(crate) async fn transaction_rows(
    listener: &mut PgListener,
    wake: &ChangeWake,
) -> Result<Vec<ChangeRow>, RealtimeError> {
    let org = wake.org.as_uuid().to_string();
    sqlx::query("SELECT set_config('app.current_org', $1, false)")
        .bind(&org)
        .execute(&mut *listener)
        .await?;
    let rows = sqlx::query(
        "SELECT seq, resource_type, resource_id, branch_id, ver FROM resource_changes \
         WHERE org_id = $1::uuid AND tx_id = $2::xid8 ORDER BY seq",
    )
    .bind(&org)
    .bind(&wake.tx)
    .fetch_all(&mut *listener)
    .await?;
    Ok(rows.iter().map(change_row).collect::<Result<_, _>>()?)
}

/// Drops rows past the replay window for one tenant (index on
/// `(org_id, created_at)`). Called from the listener at most hourly per tenant.
pub(crate) async fn prune(
    listener: &mut PgListener,
    org: OrgId,
    window: std::time::Duration,
) -> Result<(), RealtimeError> {
    sqlx::query("SELECT set_config('app.current_org', $1, false)")
        .bind(org.as_uuid().to_string())
        .execute(&mut *listener)
        .await?;
    sqlx::query(
        "DELETE FROM resource_changes WHERE org_id = $1 \
         AND created_at < now() - make_interval(secs => $2)",
    )
    .bind(*org.as_uuid())
    .bind(window.as_secs_f64())
    .execute(&mut *listener)
    .await?;
    Ok(())
}

/// The tenant's highest `seq`, or 0 when it has none (`hello`'s cursor).
pub(crate) async fn head_seq(pool: &PgPool, org: OrgId) -> Result<i64, RealtimeError> {
    let org_uuid = *org.as_uuid();
    with_org_conn::<_, _, RealtimeError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(sqlx::query_scalar(
                "SELECT COALESCE(MAX(seq), 0)::BIGINT FROM resource_changes WHERE org_id = $1",
            )
            .bind(org_uuid)
            .fetch_one(tx.as_mut())
            .await?)
        })
    })
    .await
}

/// Where a replay starts: the cursor row's transaction start minus the
/// overlap. `None` when the cursor row is gone (pruned) or never existed for
/// this tenant. Cursor 0 replays everything retained.
pub(crate) async fn replay_start(
    pool: &PgPool,
    org: OrgId,
    cursor: i64,
    overlap: std::time::Duration,
) -> Result<Option<OffsetDateTime>, RealtimeError> {
    if cursor == 0 {
        return Ok(Some(OffsetDateTime::UNIX_EPOCH));
    }
    let org_uuid = *org.as_uuid();
    let at: Option<OffsetDateTime> = with_org_conn::<_, _, RealtimeError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(sqlx::query_scalar(
                "SELECT created_at FROM resource_changes WHERE org_id = $1 AND seq = $2",
            )
            .bind(org_uuid)
            .bind(cursor)
            .fetch_optional(tx.as_mut())
            .await?)
        })
    })
    .await?;
    Ok(at.map(|at| at - overlap))
}

/// One replay page after `(created_at, seq)`, oldest first.
pub(crate) async fn replay_page(
    pool: &PgPool,
    org: OrgId,
    after: (OffsetDateTime, i64),
    limit: i64,
) -> Result<Vec<(OffsetDateTime, ChangeRow)>, RealtimeError> {
    let org_uuid = *org.as_uuid();
    let rows = with_org_conn::<_, _, RealtimeError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(sqlx::query(
                "SELECT created_at, seq, resource_type, resource_id, branch_id, ver \
                 FROM resource_changes WHERE org_id = $1 AND (created_at, seq) > ($2, $3) \
                 ORDER BY created_at, seq LIMIT $4",
            )
            .bind(org_uuid)
            .bind(after.0)
            .bind(after.1)
            .bind(limit)
            .fetch_all(tx.as_mut())
            .await?)
        })
    })
    .await?;
    rows.iter()
        .map(|row| Ok((row.try_get("created_at")?, change_row(row)?)))
        .collect::<Result<_, sqlx::Error>>()
        .map_err(RealtimeError::from)
}
