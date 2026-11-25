// SPDX-License-Identifier: LicenseRef-Proprietary
//! Filtered listing query for payroll draft runs (`GET /api/v1/payroll/runs`).

use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::{DEFAULT_LIMIT, MAX_LIMIT, PayrollRunPage, PgPayrollError, run_summary_from_row};

/// Org-scoped page of payroll draft runs, newest period first. Runs of pay
/// groups are left out: this caller has no visible set to admit them.
pub async fn list_runs_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<PayrollRunPage, PgPayrollError> {
    list_runs_filtered_in_tx(tx, limit, offset, None, None, &[]).await
}

/// Filtered org-scoped page of payroll draft runs, newest period first. A run of
/// a pay group outside `visible` is left out of the page and of its total.
pub async fn list_runs_filtered_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    limit: Option<i64>,
    offset: Option<i64>,
    pay_group_id: Option<Uuid>,
    legal_entity_id: Option<Uuid>,
    visible: &[Uuid],
) -> Result<PayrollRunPage, PgPayrollError> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = offset.unwrap_or(0).max(0);
    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) \
         FROM payroll_draft_runs r \
         LEFT JOIN pay_groups g ON g.org_id = r.org_id AND g.id = r.pay_group_id \
         WHERE ($1::uuid IS NULL OR r.pay_group_id = $1) \
           AND ($2::uuid IS NULL OR g.legal_entity_id = $2) \
           AND (r.pay_group_id IS NULL OR r.pay_group_id = ANY($3))",
    )
    .bind(pay_group_id)
    .bind(legal_entity_id)
    .bind(visible)
    .fetch_one(tx.as_mut())
    .await?;

    let rows = sqlx::query(
        r#"
        SELECT r.id, g.legal_entity_id, r.pay_group_id, r.kind,
               to_char(r.attribution_month, 'YYYY-MM') AS attribution_month,
               r.pay_date, r.period_start, r.period_end,
               r.variable_period_start, r.variable_period_end,
               r.source_label, r.status, r.calculation_enabled, r.created_by,
               r.approved_by, r.approved_at, r.close_receipt, r.submitted_by,
               r.submitted_at, r.decided_by, r.decided_at, r.decision_reason,
               r.approval_ref, r.created_at, r.updated_at
        FROM payroll_draft_runs r
        LEFT JOIN pay_groups g ON g.org_id = r.org_id AND g.id = r.pay_group_id
        WHERE ($1::uuid IS NULL OR r.pay_group_id = $1)
          AND ($2::uuid IS NULL OR g.legal_entity_id = $2)
          AND (r.pay_group_id IS NULL OR r.pay_group_id = ANY($5))
        ORDER BY r.period_start DESC, r.period_end DESC, r.id DESC
        LIMIT $3 OFFSET $4
        "#,
    )
    .bind(pay_group_id)
    .bind(legal_entity_id)
    .bind(limit)
    .bind(offset)
    .bind(visible)
    .fetch_all(tx.as_mut())
    .await?;

    let items = rows
        .iter()
        .map(run_summary_from_row)
        .collect::<Result<Vec<_>, _>>()?;

    Ok(PayrollRunPage {
        items,
        total,
        limit,
        offset,
    })
}
