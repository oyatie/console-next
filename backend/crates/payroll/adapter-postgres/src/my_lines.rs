// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

/// Read own readiness after the caller's Cedar decision in this transaction.
pub async fn list_my_lines_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    employee_id: Uuid,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<MyPayrollLinePage, PgPayrollError> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = offset.unwrap_or(0).max(0);
    let total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM payroll_draft_lines WHERE employee_id = $1")
            .bind(employee_id)
            .fetch_one(tx.as_mut())
            .await?;

    // Readiness projection: hours + *_source_present. Never SELECT *_won.
    let rows = sqlx::query(
        r#"
            SELECT r.id AS run_id, r.period_start, r.period_end, r.status AS run_status,
                   l.calculation_status,
                   l.work_days::float8 AS work_days,
                   l.regular_hours::float8 AS regular_hours,
                   l.overtime_hours::float8 AS overtime_hours,
                   l.night_hours::float8 AS night_hours,
                   l.holiday_hours::float8 AS holiday_hours,
                   l.leave_used::float8 AS leave_used,
                   l.leave_remaining::float8 AS leave_remaining,
                   l.gross_pay_source_present, l.net_pay_source_present
            FROM payroll_draft_lines l
            JOIN payroll_draft_runs r ON r.id = l.run_id
            WHERE l.employee_id = $1
            ORDER BY r.period_start DESC, r.period_end DESC, l.id DESC
            LIMIT $2 OFFSET $3
            "#,
    )
    .bind(employee_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(tx.as_mut())
    .await?;
    let items = rows
        .iter()
        .map(my_line_from_row)
        .collect::<Result<Vec<_>, PgPayrollError>>()?;

    Ok(MyPayrollLinePage {
        items,
        total,
        limit,
        offset,
    })
}
