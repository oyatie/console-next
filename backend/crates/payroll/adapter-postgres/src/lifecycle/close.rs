// SPDX-License-Identifier: LicenseRef-Proprietary
//! Close preflight and attendance close.
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use time::format_description::well_known::Iso8601;
use uuid::Uuid;

use super::{
    ClosePreflight, LifecycleError, PREFLIGHT_REF_CAP, PreflightCheck, RunHead, invalid_state,
    json_internal, run_head,
};
use crate::roster::{CLOSEABLE, refresh_in_tx};

/// The three preflight checks derivable from real tables today:
/// attendance-material coverage per line, an active payroll period lock
/// covering the run period, and (soft warn) pending leave requests
/// overlapping the period. `can_close` is the AND of the hard checks.
pub async fn close_preflight_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
) -> Result<Option<ClosePreflight>, LifecycleError> {
    let Some(run) = run_head(tx, run_id, false).await? else {
        return Ok(None);
    };
    // The verdict judges the roster the close would write; the savepoint keeps
    // that roster unsaved, so a read never changes the register.
    // shortcut: each read rewrites every member line, then discards it, and holds
    // the run's row lock meanwhile; skip unchanged rows in the upsert if polling
    // ever shows as table bloat or close waiting on readers.
    sqlx::query("SAVEPOINT close_preflight")
        .execute(tx.as_mut())
        .await?;
    refresh_in_tx(tx, run_id).await?;
    let verdict = preflight_for(tx, &run).await?;
    sqlx::query("ROLLBACK TO SAVEPOINT close_preflight")
        .execute(tx.as_mut())
        .await?;
    Ok(Some(verdict))
}

async fn preflight_for(
    tx: &mut Transaction<'_, Postgres>,
    run: &RunHead,
) -> Result<ClosePreflight, LifecycleError> {
    // 1. Every roster line must carry attendance material (source rows or
    //    direct events). Lines without any are the blocking refs (fix-links).
    //    A VOID line is someone no longer on the roster.
    let missing_total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM payroll_draft_lines \
         WHERE run_id = $1 AND attendance_source_row_count = 0 AND attendance_event_count = 0 \
           AND calculation_status <> 'VOID'",
    )
    .bind(run.id)
    .fetch_one(tx.as_mut())
    .await?;
    let missing_refs: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM payroll_draft_lines \
         WHERE run_id = $1 AND attendance_source_row_count = 0 AND attendance_event_count = 0 \
           AND calculation_status <> 'VOID' \
         ORDER BY employee_company, employee_display_name LIMIT $2",
    )
    .bind(run.id)
    .bind(PREFLIGHT_REF_CAP)
    .fetch_all(tx.as_mut())
    .await?;
    // A run with NO lines had `missing_total == 0` and so passed this check
    // vacuously: `COUNT(*) WHERE ... = 0` over an empty roster is 0, and 0 == 0.
    // Since `can_close` is the AND of the hard checks, an empty run closed on the
    // period lock alone, took an "attendance source secured" attestation over
    // zero evidence, and carried on down the lifecycle. A guard that examines no
    // subject must fail, not pass -- the same rule this repository already
    // applies to the canonical enforcement floor and the preflight gate sweep.
    let roster_total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM payroll_draft_lines WHERE run_id = $1 AND calculation_status <> 'VOID'",
    )
    .bind(run.id)
    .fetch_one(tx.as_mut())
    .await?;
    let attendance = PreflightCheck {
        key: "attendance_material",
        label_ko: "근태 원천 확보",
        ok: roster_total > 0 && missing_total == 0,
        warn: false,
        note: if roster_total == 0 {
            // Distinct from the missing-material note: nothing to attest is a
            // different problem from someone lacking attendance, and an attestor
            // reading "attendance source missing: 0 people" would reasonably
            // read it as clean.
            Some("명세 대상 없음(로스터 0명)".to_owned())
        } else {
            (missing_total > 0).then(|| format!("근태 원천 누락 {missing_total}명"))
        },
        blocking_refs: missing_refs,
    };

    // 2. An active payroll period lock must cover the whole run period.
    let lock_active: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM period_locks \
         WHERE domain = 'payroll' AND period_lock_effective(period_locks) \
           AND period_start <= $1 AND period_end >= $2)",
    )
    .bind(run.period_start)
    .bind(run.period_end)
    .fetch_one(tx.as_mut())
    .await?;
    let period_lock = PreflightCheck {
        key: "period_lock",
        label_ko: "급여 기간 동결",
        ok: lock_active,
        warn: false,
        note: (!lock_active).then(|| "급여 동결창(기간 잠금) 미설정".to_owned()),
        blocking_refs: Vec::new(),
    };

    // 3. Soft warn: pending leave requests overlapping the period may still
    //    change attendance figures. Never blocks — surfaced for the attestor.
    let pending_leave: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM leave_requests \
         WHERE status = 'pending' AND start_date <= $1 AND end_date >= $2 \
         ORDER BY start_date LIMIT $3",
    )
    .bind(run.period_end)
    .bind(run.period_start)
    .bind(PREFLIGHT_REF_CAP)
    .fetch_all(tx.as_mut())
    .await?;
    let leave = PreflightCheck {
        key: "pending_leave",
        label_ko: "미결 휴가 신청",
        ok: true,
        warn: !pending_leave.is_empty(),
        note: (!pending_leave.is_empty()).then(|| format!("미결 휴가 {}건", pending_leave.len())),
        blocking_refs: pending_leave,
    };

    let can_close = attendance.ok && period_lock.ok;
    Ok(ClosePreflight {
        checks: vec![attendance, period_lock, leave],
        can_close,
    })
}

pub async fn close_attendance_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
    actor: Uuid,
    now: OffsetDateTime,
) -> Result<Value, LifecycleError> {
    let Some(run) = run_head(tx, run_id, true).await? else {
        return Err(LifecycleError::NotFound);
    };
    if !CLOSEABLE.contains(&run.status.as_str()) {
        return Err(invalid_state("close attendance for", &run.status));
    }
    // The last write to the lines: from ATTENDANCE_CLOSED on nothing rewrites them.
    refresh_in_tx(tx, run_id).await?;
    // Recomputed HERE, inside the closing transaction, behind the run's
    // FOR UPDATE lock — never read back from a verdict computed earlier
    // (`close_receipt` is the attestation record this close writes, never an
    // input to it). A verdict trusted later is a TOCTOU hole.
    let preflight = preflight_for(tx, &run).await?;
    if !preflight.can_close {
        return Err(LifecycleError::PreflightBlocked(preflight));
    }

    let receipt = json!({
        "checks": serde_json::to_value(&preflight.checks).map_err(json_internal)?,
        "attested_by": actor,
        "attested_at": now.format(&Iso8601::DEFAULT).map_err(|err| {
            LifecycleError::Validation(format!("failed to format attestation time: {err}"))
        })?,
    });
    sqlx::query(
        "UPDATE payroll_draft_runs \
         SET status = 'ATTENDANCE_CLOSED', close_receipt = $2, updated_at = now() \
         WHERE id = $1",
    )
    .bind(run_id)
    .bind(&receipt)
    .execute(tx.as_mut())
    .await?;
    Ok(receipt)
}
