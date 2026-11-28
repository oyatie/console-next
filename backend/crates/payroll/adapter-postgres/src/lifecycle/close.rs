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
/// attendance-material coverage per line of a defined roster, an active payroll
/// period lock covering the run period, and (soft warn) pending leave requests
/// overlapping the period. `can_close` is the AND of the hard checks.
pub async fn close_preflight_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
) -> Result<Option<ClosePreflight>, LifecycleError> {
    // Locked before `saved` is read, so a line committed by a writer it waited on is saved.
    let Some(run) = run_head(tx, run_id, true).await? else {
        return Ok(None);
    };
    // The verdict judges the roster the close would write; the savepoint keeps
    // that roster unsaved, so a read never changes the register.
    // shortcut: each read rewrites every member line, then discards it, and holds
    // the run's row lock meanwhile; skip unchanged rows in the upsert if polling
    // ever shows as table bloat or close waiting on readers.
    let saved = saved_lines(tx, run_id).await?;
    sqlx::query("SAVEPOINT close_preflight")
        .execute(tx.as_mut())
        .await?;
    refresh_in_tx(tx, run_id).await?;
    let verdict = preflight_for(tx, &run, &saved).await?;
    sqlx::query("ROLLBACK TO SAVEPOINT close_preflight")
        .execute(tx.as_mut())
        .await?;
    Ok(Some(verdict))
}

async fn saved_lines(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
) -> Result<Vec<Uuid>, LifecycleError> {
    Ok(
        sqlx::query_scalar("SELECT id FROM payroll_draft_lines WHERE run_id = $1")
            .bind(run_id)
            .fetch_all(tx.as_mut())
            .await?,
    )
}

/// `saved` are the run's lines before the refresh: only they may be fix-links,
/// since a line the refresh adds is rolled back with the read or the refused
/// close, and its id would link to nothing. The note still counts it.
async fn preflight_for(
    tx: &mut Transaction<'_, Postgres>,
    run: &RunHead,
    saved: &[Uuid],
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
           AND calculation_status <> 'VOID' AND id = ANY($3) \
         ORDER BY employee_company, employee_display_name LIMIT $2",
    )
    .bind(run.id)
    .bind(PREFLIGHT_REF_CAP)
    .bind(saved)
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
    // A regular run's roster is defined when its legal entity has one pay group,
    // or when every active entity member overlapping the period has a pay-group assignment.
    let group_ctx: Option<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT r.org_id, g.legal_entity_id FROM payroll_draft_runs r \
         JOIN pay_groups g ON g.org_id = r.org_id AND g.id = r.pay_group_id \
         WHERE r.id = $1 AND r.kind = 'REGULAR'",
    )
    .bind(run.id)
    .fetch_optional(tx.as_mut())
    .await?;
    let undefined = if let (Some((org_id, le_id)), Some(pg_id)) = (group_ctx, run.pay_group_id) {
        crate::pay_groups::run_preview::entity_roster_ambiguous_in_tx(
            tx,
            org_id,
            le_id,
            pg_id,
            run.period_start,
            run.period_end,
        )
        .await?
    } else {
        false
    };
    let attendance = PreflightCheck {
        key: "attendance_material",
        label_ko: "근태 원천 확보",
        ok: !undefined && roster_total > 0 && missing_total == 0,
        warn: false,
        note: if undefined {
            // The cause, as the code the run create refuses with.
            Some("pay_group_roster_ambiguous".to_owned())
        } else if roster_total == 0 {
            // Distinct from the missing-material note: nothing to attest is a
            // different problem from someone lacking attendance, and an attestor
            // reading "attendance source missing: 0 people" would reasonably
            // read it as clean.
            Some("명세 대상 없음(로스터 0명)".to_owned())
        } else {
            (missing_total > 0).then(|| format!("근태 원천 누락 {missing_total}명"))
        },
        // No line is the fix while membership itself is unknown.
        blocking_refs: if undefined { Vec::new() } else { missing_refs },
    };

    // 2. An active payroll period lock (tenant-wide or scoped to this pay group) must cover the whole run period.
    let lock_active: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM period_locks \
         WHERE domain = 'payroll' AND period_lock_effective(period_locks) \
           AND (pay_group_id IS NULL OR pay_group_id = $3) \
           AND period_start <= $1 AND period_end >= $2)",
    )
    .bind(run.period_start)
    .bind(run.period_end)
    .bind(run.pay_group_id)
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

    // 4. Soft warn: unclosed branch attendance months surface for operator acknowledgement without blocking close.
    let unclosed_branches: Vec<Uuid> = sqlx::query_scalar(
        "SELECT b.id FROM branches b \
         WHERE NOT EXISTS ( \
             SELECT 1 FROM attendance_month_closes amc \
             WHERE amc.org_id = b.org_id AND amc.month = date_trunc('month', $1::timestamp)::date \
               AND (amc.branch_id IS NULL OR amc.branch_id = b.id) \
         ) \
         ORDER BY b.id LIMIT $2",
    )
    .bind(run.period_start)
    .bind(PREFLIGHT_REF_CAP)
    .fetch_all(tx.as_mut())
    .await?;
    let mut checks = vec![attendance, period_lock, leave];
    if !unclosed_branches.is_empty() {
        let count = unclosed_branches.len();
        checks.push(PreflightCheck {
            key: "workplace_attendance_close",
            label_ko: "workplace_attendance_close",
            ok: true,
            warn: true,
            note: Some(format!("unclosed_workplaces:{count}")),
            blocking_refs: unclosed_branches,
        });
    }

    let can_close = checks[0].ok && checks[1].ok;
    Ok(ClosePreflight { checks, can_close })
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
    // Different regular runs for one entity and month must see each other's committed
    // rosters before freezing. Import runs and off-cycle runs have independent rosters.
    sqlx::query(
        "SELECT pg_advisory_xact_lock(hashtextextended('payroll-roster:' || pg.legal_entity_id::text || ':' || r.attribution_month::text, 0))
         FROM payroll_draft_runs r JOIN pay_groups pg ON pg.org_id = r.org_id AND pg.id = r.pay_group_id
         WHERE r.id = $1 AND r.kind = 'REGULAR'",
    )
    .bind(run_id)
    .execute(tx.as_mut())
    .await?;
    let saved = saved_lines(tx, run_id).await?;
    // The last write to the lines: from ATTENDANCE_CLOSED on nothing rewrites them.
    refresh_in_tx(tx, run_id).await?;
    // Recomputed HERE, inside the closing transaction, behind the run's
    // FOR UPDATE lock — never read back from a verdict computed earlier
    // (`close_receipt` is the attestation record this close writes, never an
    // input to it). A verdict trusted later is a TOCTOU hole.
    let preflight = preflight_for(tx, &run, &saved).await?;
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
