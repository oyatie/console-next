//! Reason-code usage (BW-07 stats): per stored code column, the rows that
//! carry a code, the rows that carry `OTHER` (기타), and the count per code.

use crate::{PgSettingsError, PgSettingsStore};
use console_kernel_core::OrgId;
use console_platform_db::{DbError, with_org_conn};
use console_settings_domain::code_lists::OTHER;
use serde::Serialize;
use sqlx::Row;

/// Usage of one stored code column: which domains write it, how many rows
/// carry a code, how many carry `OTHER` (기타), and the count per code.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SourceStats {
    pub source: &'static str,
    pub domains: &'static [&'static str],
    pub total: i64,
    pub other: i64,
    pub other_rate: Option<f64>,
    pub codes: Vec<CodeCount>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CodeCount {
    pub code: String,
    pub count: i64,
}

/// The stored code columns (migration column contract). A column shared by
/// several domains has no domain discriminator in its row, so stats are per
/// column.
// per column, not per domain; split once the writers (W2 lanes)
// record a domain-discriminating action.
const SOURCES: &[(&str, &[&str])] = &[
    (
        "org_change_events.reason_code",
        &[
            "org_change_reason",
            "org_change_reject",
            "org_change_cancel",
            "org_change_withdraw",
            "approval_return",
        ],
    ),
    (
        "org_change_approval_steps.reason_code",
        &["org_change_reject", "approval_return"],
    ),
    (
        "employee_lifecycle_events.reason_code",
        &["lifecycle_transfer", "lifecycle_promote"],
    ),
    (
        "employee_lifecycle_events.cancel_reason_code",
        &["lifecycle_cancel"],
    ),
    (
        "employee_exit_cases.closed_reason_code",
        &["exit_reject", "exit_cancel"],
    ),
    ("period_locks.reason_code", &["period_lock"]),
    ("period_locks.unlock_reason_code", &["period_unlock"]),
];

/// One `SELECT` per [`SOURCES`] column, labelled with its source.
const STATS_SQL: &str = "
SELECT source, code, count(*)::BIGINT AS n FROM (
    SELECT 'org_change_events.reason_code' AS source, reason_code AS code
      FROM org_change_events WHERE org_id = $1 AND reason_code IS NOT NULL
    UNION ALL
    SELECT 'org_change_approval_steps.reason_code', reason_code
      FROM org_change_approval_steps WHERE org_id = $1 AND reason_code IS NOT NULL
    UNION ALL
    SELECT 'employee_lifecycle_events.reason_code', reason_code
      FROM employee_lifecycle_events WHERE org_id = $1 AND reason_code IS NOT NULL
    UNION ALL
    SELECT 'employee_lifecycle_events.cancel_reason_code', cancel_reason_code
      FROM employee_lifecycle_events WHERE org_id = $1 AND cancel_reason_code IS NOT NULL
    UNION ALL
    SELECT 'employee_exit_cases.closed_reason_code', closed_reason_code
      FROM employee_exit_cases WHERE org_id = $1 AND closed_reason_code IS NOT NULL
    UNION ALL
    SELECT 'period_locks.reason_code', reason_code
      FROM period_locks WHERE org_id = $1 AND reason_code IS NOT NULL
    UNION ALL
    SELECT 'period_locks.unlock_reason_code', unlock_reason_code
      FROM period_locks WHERE org_id = $1 AND unlock_reason_code IS NOT NULL
) s
GROUP BY source, code
ORDER BY source, n DESC, code";

impl PgSettingsStore {
    /// Per stored code column: rows with a code, rows with `OTHER`, and the
    /// count per code, for the tenant.
    ///
    /// # Errors
    /// Internal on a query failure.
    pub async fn reason_stats(&self, org: OrgId) -> Result<Vec<SourceStats>, PgSettingsError> {
        with_org_conn(&self.pool, org, move |tx| {
            Box::pin(async move {
                let rows = sqlx::query(STATS_SQL)
                    .bind(org.as_uuid())
                    .fetch_all(tx.as_mut())
                    .await
                    .map_err(DbError::Sqlx)?;
                let mut out: Vec<SourceStats> = SOURCES
                    .iter()
                    .map(|(source, domains)| SourceStats {
                        source,
                        domains,
                        total: 0,
                        other: 0,
                        other_rate: None,
                        codes: Vec::new(),
                    })
                    .collect();
                for row in rows {
                    let source: String = row.try_get("source").map_err(DbError::Sqlx)?;
                    let code: String = row.try_get("code").map_err(DbError::Sqlx)?;
                    let count: i64 = row.try_get("n").map_err(DbError::Sqlx)?;
                    if let Some(s) = out.iter_mut().find(|s| s.source == source) {
                        s.total += count;
                        if code == OTHER.code {
                            s.other += count;
                        }
                        s.codes.push(CodeCount { code, count });
                    }
                }
                for s in &mut out {
                    #[allow(clippy::cast_precision_loss)]
                    let rate = (s.total > 0).then(|| s.other as f64 / s.total as f64);
                    s.other_rate = rate;
                }
                Ok(out)
            })
        })
        .await
    }
}
