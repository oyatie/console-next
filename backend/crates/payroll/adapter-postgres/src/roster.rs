// SPDX-License-Identifier: LicenseRef-Proprietary
//! Materialise a payroll run's roster: a pay-group run lists its group's members,
//! an import run the people the governed import ledger declares for its period.

use sqlx::{Postgres, Transaction};
use time::Date;
use uuid::Uuid;

mod placement;
mod sql;
use sql::MATERIALISE_ROSTER_SQL;

/// Statuses a run may be closed from, and so the only ones whose lines may be
/// written.
pub(crate) const CLOSEABLE: [&str; 3] = ["STAGED", "BLOCKED_LEGAL_GATE", "READY_FOR_REVIEW"];

/// Materialise the roster for `run_id`: a pay-group run's members, or an import
/// run's people with material declared for exactly this pay period, each placed
/// as of the period end.
pub async fn materialise_roster_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    run_id: Uuid,
    period_start: Date,
    period_end: Date,
) -> Result<u64, sqlx::Error> {
    // The lock serialises staging with close and calculate.
    let status: Option<String> = sqlx::query_scalar(
        "SELECT status FROM payroll_draft_runs WHERE org_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(org_id)
    .bind(run_id)
    .fetch_optional(tx.as_mut())
    .await?;
    if !status.is_some_and(|status| CLOSEABLE.contains(&status.as_str())) {
        return Ok(0);
    }
    let written: i64 = sqlx::query_scalar(MATERIALISE_ROSTER_SQL)
        .bind(org_id)
        .bind(run_id)
        .bind(period_start)
        .bind(period_end)
        .fetch_one(tx.as_mut())
        .await?;
    placement::place_lines_in_tx(tx, org_id, run_id).await?;
    Ok(u64::try_from(written).unwrap_or(0))
}

/// Brings an open run's lines up to date with People before its roster is judged.
pub(crate) async fn refresh_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
) -> Result<(), sqlx::Error> {
    let run: Option<(Uuid, Date, Date, bool, String)> = sqlx::query_as(
        "SELECT org_id, period_start, period_end, pay_group_id IS NOT NULL, status \
         FROM payroll_draft_runs WHERE id = $1 FOR UPDATE",
    )
    .bind(run_id)
    .fetch_optional(tx.as_mut())
    .await?;
    let Some((org, start, end, of_group, status)) = run else {
        return Ok(());
    };
    if !CLOSEABLE.contains(&status.as_str()) {
        return Ok(());
    }
    if of_group {
        materialise_roster_in_tx(tx, org, run_id, start, end).await?;
    } else {
        placement::place_lines_in_tx(tx, org, run_id).await?;
    }
    Ok(())
}
