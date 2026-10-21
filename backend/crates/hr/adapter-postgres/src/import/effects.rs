// SPDX-License-Identifier: LicenseRef-Proprietary
//! Append-only provenance for the effects settled by an employee import.

use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::HrError;

/// Record an actual write in the same transaction as the import effect.
///
/// # Errors
/// A database error, including an invalid effect or mismatched tenant.
pub async fn record(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    run: Uuid,
    employee: Uuid,
    effect: &str,
    target: Uuid,
) -> Result<(), HrError> {
    sqlx::query(
        "INSERT INTO import_run_effects (org_id, run_id, employee_id, effect, target_id, target_digest) \
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $4 = 'profile_created' THEN \
           (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM employee_employment_profiles p \
            WHERE p.org_id=$1 AND p.employee_id=$5) END) \
         ON CONFLICT (org_id, run_id, employee_id, effect, target_id) DO NOTHING",
    )
    .bind(org)
    .bind(run)
    .bind(employee)
    .bind(effect)
    .bind(target)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

/// Mark each head only after all writes for these source rows have settled.
///
/// # Errors
/// A database error while storing the completion baseline.
pub async fn capture_heads(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    run: Uuid,
    keys: &[String],
) -> Result<(), HrError> {
    sqlx::query(
        "INSERT INTO import_run_effects \
         (org_id, run_id, employee_id, effect, target_id, created_at) \
         SELECT s.org_id, s.run_id, s.employee_id, 'head_settled', e.id, clock_timestamp() \
         FROM import_run_row_snapshots s \
         JOIN employees e ON e.org_id = s.org_id AND e.id = s.employee_id \
         WHERE s.org_id = $1 AND s.run_id = $2 AND s.source_key = ANY($3::TEXT[]) \
         ON CONFLICT (org_id, run_id, employee_id, effect, target_id) DO NOTHING",
    )
    .bind(org)
    .bind(run)
    .bind(keys)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

/// Establish missing routing branches for this chunk through the import-scoped command.
/// The command records provenance only when it actually assigns a branch.
pub async fn assign_home_branches(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    actor: Uuid,
    run: Uuid,
    keys: &[String],
) -> Result<(), HrError> {
    let people: Vec<Uuid> = sqlx::query_scalar(
        "WITH people AS (SELECT s.employee_id FROM import_run_row_snapshots s WHERE s.org_id=$1 AND s.run_id=$2 AND s.source_key=ANY($3) \
         UNION SELECT (p.row->>'employee_id')::UUID FROM data_import_runs r \
         CROSS JOIN LATERAL jsonb_array_elements(r.dry_run_summary->'rows') p(row) \
         WHERE r.org_id=$1 AND r.id=$2 AND p.row->>'source_key'=ANY($3) AND p.row->>'employee_id' IS NOT NULL) \
         SELECT e.id FROM people p JOIN employees e ON e.org_id=$1 AND e.id=p.employee_id \
         WHERE e.home_branch_id IS NULL AND e.employment_status IN ('ACTIVE','ON_LEAVE') \
         AND EXISTS (SELECT 1 FROM employment_assignments a JOIN workplaces w ON w.org_id=a.org_id AND w.id=a.workplace_id \
           WHERE a.org_id=$1 AND a.employee_id=e.id AND a.superseded_at IS NULL AND w.default_branch_id IS NOT NULL \
             AND a.valid_from <= (now() AT TIME ZONE 'Asia/Seoul')::DATE \
             AND (a.valid_to IS NULL OR a.valid_to > (now() AT TIME ZONE 'Asia/Seoul')::DATE)) ORDER BY e.id",
    ).bind(org).bind(run).bind(keys).fetch_all(tx.as_mut()).await?;
    let trace = console_kernel_core::TraceContext::generate();
    for employee in people {
        sqlx::query("SELECT leave_api.set_employee_import_home_branch($1,$2,$3,$4,$5,$6)")
            .bind(org)
            .bind(run)
            .bind(employee)
            .bind(actor)
            .bind(trace.trace_id())
            .bind(trace.span_id())
            .execute(tx.as_mut())
            .await?;
    }
    Ok(())
}
