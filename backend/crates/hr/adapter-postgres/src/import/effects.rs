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
