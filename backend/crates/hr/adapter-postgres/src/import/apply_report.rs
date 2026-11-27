//! W11: the report an applied run answers — the leave command's
//! `apply_summary` plus what the plan adds (bound units, the unplaced counts).

use console_kernel_core::OrgId;
use console_platform_db::with_org_conn;
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use crate::HrError;
use crate::import::types::{EmployeeImportReport, RegisterGaps, SkippedImportRow};

/// The leave command's report plus what the settle and the plan add.
pub async fn final_report(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: OrgId,
    run_id: Uuid,
) -> Result<EmployeeImportReport, HrError> {
    let (summary, unplaced, rows, bound): (Value, Option<Value>, Option<Value>, i64) =
        sqlx::query_as(
            "SELECT r.apply_summary, r.dry_run_summary->'unplaced', r.dry_run_summary->'rows', \
                (SELECT count(*) FROM import_run_row_snapshots s \
                   JOIN person_employees_current e ON e.org_id = s.org_id AND e.id = s.employee_id \
                  WHERE s.org_id = r.org_id AND s.run_id = r.id \
                    AND s.outcome = 'INSERTED' AND e.org_unit_id IS NOT NULL) \
           FROM data_import_runs r WHERE r.org_id = $1 AND r.id = $2",
        )
        .bind(org.as_uuid())
        .bind(run_id)
        .fetch_one(tx.as_mut())
        .await?;
    let mut report: EmployeeImportReport = serde_json::from_value(summary)
        .map_err(|e| HrError::internal(format!("invalid employee import report: {e}")))?;
    report.org_units_bound = usize::try_from(bound).unwrap_or_default();
    report.unplaced = unplaced.and_then(|u| serde_json::from_value(u).ok());
    report.skipped_rows = rows
        .as_ref()
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|row| {
            !matches!(
                row["outcome"].as_str(),
                Some("insert" | "update" | "unchanged" | "excluded")
            )
        })
        .map(|row| SkippedImportRow {
            sheet: row["sheet"].as_str().unwrap_or_default().to_owned(),
            row: i32::try_from(row["row"].as_i64().unwrap_or_default()).unwrap_or_default(),
            source_key: row["source_key"].as_str().unwrap_or_default().to_owned(),
            employee_number: row["employee_number"].as_str().map(str::to_owned),
            outcome: row["outcome"].as_str().unwrap_or_default().to_owned(),
            reason_code: row["reason"].as_str().map(str::to_owned),
        })
        .collect();
    Ok(report)
}

/// The register items the run's new people lack now, read in the settle's last
/// transaction (after its writes) or on its own for a resumed job.
pub async fn register_gaps_in(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: Uuid,
    run_id: Uuid,
) -> Result<RegisterGaps, HrError> {
    let counts: (i64, i64, i64, i64, i64) = sqlx::query_as(
        "SELECT count(*), count(*) FILTER (WHERE f.sex IS NULL), \
                count(*) FILTER (WHERE f.address_id IS NULL), \
                count(*) FILTER (WHERE f.career_none IS NULL AND NOT EXISTS ( \
                  SELECT 1 FROM employee_careers c WHERE c.org_id = e.org_id \
                     AND c.employee_id = e.id AND c.voided_at IS NULL)), \
                count(*) FILTER (WHERE e.employment_status = 'EXITED' \
                                   AND f.exit_reason_code IS NULL) \
           FROM import_run_row_snapshots s \
           JOIN person_employees_current e ON e.org_id = s.org_id AND e.id = s.employee_id \
           LEFT JOIN employee_register_facts f ON f.org_id = e.org_id AND f.employee_id = e.id \
          WHERE s.org_id = $1 AND s.run_id = $2 AND s.outcome = 'INSERTED'",
    )
    .bind(org)
    .bind(run_id)
    .fetch_one(tx.as_mut())
    .await?;
    let n = |v: i64| usize::try_from(v).unwrap_or_default();
    Ok(RegisterGaps {
        people: n(counts.0),
        sex: n(counts.1),
        address: n(counts.2),
        careers: n(counts.3),
        exit_reason: n(counts.4),
    })
}

/// [`register_gaps_in`] on its own connection.
pub async fn register_gaps(
    pool: &PgPool,
    org: OrgId,
    run_id: Uuid,
) -> Result<RegisterGaps, HrError> {
    with_org_conn::<_, _, HrError>(pool, org, move |tx| {
        Box::pin(async move { register_gaps_in(tx, *org.as_uuid(), run_id).await })
    })
    .await
}
