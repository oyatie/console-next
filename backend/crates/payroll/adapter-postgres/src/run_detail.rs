// SPDX-License-Identifier: LicenseRef-Proprietary
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

#[path = "run_detail_rows.rs"]
mod rows;
pub(crate) use rows::fetch_run_row;
use rows::{escape_like, line_summary_from_row};

use crate::{
    DEFAULT_LIMIT, MAX_LIMIT, PayrollRunSummary, PgPayrollError, lifecycle, run_summary_from_row,
};

#[derive(Debug, Clone, Serialize)]
pub struct PayrollRunDetail {
    pub run: PayrollRunSummary,
    pub legal_basis: Value,
    pub source_summary: Value,
    pub lines: Vec<PayrollLineSummary>,
    pub lines_total: i64,
    pub lines_limit: i64,
    pub lines_offset: i64,
    pub missing_bank_account_count: i64,
    pub exceptions_open: i64,
    pub exceptions_total: i64,
    pub calculation: Option<lifecycle::RunCalcSummary>,
    pub disbursement: Option<lifecycle::Disbursement>,
    pub payslip_delivery: Option<lifecycle::PayslipDeliverySummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PayrollLineDeduction {
    pub code: String,
    pub label_ko: String,
    pub amount_won: i64,
    pub source_url: String,
}

/// One employee's readiness/staging row for a run, plus optional calculation
/// figures once a draft calculation row exists.
#[derive(Debug, Clone, Serialize)]
pub struct PayrollLineSummary {
    pub id: Uuid,
    pub employee_id: Option<Uuid>,
    pub employee_number: Option<String>,
    pub employee_display_name: String,
    pub employee_company: String,
    pub org_unit: Option<String>,
    pub position: Option<String>,
    pub work_days: Option<f64>,
    pub paid_holiday_days: Option<f64>,
    pub regular_hours: Option<f64>,
    pub overtime_hours: Option<f64>,
    pub night_hours: Option<f64>,
    pub holiday_hours: Option<f64>,
    pub leave_used: Option<f64>,
    pub leave_remaining: Option<f64>,
    pub gross_pay_source_present: bool,
    pub net_pay_source_present: bool,
    pub bank_account_registered: bool,
    pub nts_tax_row_status: String,
    pub calculation_status: String,
    pub blockers: Value,
    pub calculation_version: Option<i32>,
    pub base_pay_won: Option<i64>,
    pub overtime_pay_won: Option<i64>,
    pub meal_allowance_won: Option<i64>,
    pub taxable_won: Option<i64>,
    pub gross_won: Option<i64>,
    pub deductions: Option<Vec<PayrollLineDeduction>>,
    pub total_deductions_won: Option<i64>,
    pub net_won: Option<i64>,
    pub tax_table_version: Option<String>,
}

/// Query logic behind [`crate::PgPayrollStore::get_run`]; see
/// [`crate::list_runs_in_tx`] on why this takes an already-armed `tx` rather
/// than owning its own transaction.
pub async fn get_run_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
    lines_limit: Option<i64>,
    lines_offset: Option<i64>,
) -> Result<Option<PayrollRunDetail>, PgPayrollError> {
    get_run_filtered_in_tx(tx, run_id, lines_limit, lines_offset, false, None).await
}

pub async fn get_run_filtered_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
    lines_limit: Option<i64>,
    lines_offset: Option<i64>,
    missing_bank_only: bool,
    q: Option<&str>,
) -> Result<Option<PayrollRunDetail>, PgPayrollError> {
    let lines_limit = lines_limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let lines_offset = lines_offset.unwrap_or(0).max(0);
    let search_pattern = q.map(str::trim).filter(|s| !s.is_empty()).map(escape_like);

    let Some(run_row) = fetch_run_row(tx, run_id).await? else {
        return Ok(None);
    };
    let run = run_summary_from_row(&run_row)?;
    let legal_basis: Value = run_row.try_get("legal_basis")?;
    let source_summary: Value = run_row.try_get("source_summary")?;

    let counts_row = sqlx::query(
        "SELECT COUNT(*)::bigint AS run_lines_total, \
                COUNT(*) FILTER (WHERE NOT bank_account_registered)::bigint AS missing_bank_account_count \
         FROM payroll_draft_lines WHERE run_id = $1",
    )
    .bind(run_id)
    .fetch_one(tx.as_mut())
    .await?;
    let run_lines_total: i64 = counts_row.try_get("run_lines_total")?;
    let missing_bank_account_count: i64 = counts_row.try_get("missing_bank_account_count")?;

    let lines_total: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint
        FROM payroll_draft_lines l
        LEFT JOIN employees e ON e.org_id = l.org_id AND e.id = l.employee_id
        LEFT JOIN LATERAL (
            SELECT r.attributes
            FROM org_unit_revisions r
            WHERE r.org_id = e.org_id AND r.org_unit_id = e.org_unit_id
            ORDER BY r.version DESC
            LIMIT 1
        ) ou ON e.org_unit_id IS NOT NULL
        LEFT JOIN job_titles jt ON jt.org_id = e.org_id AND jt.id = e.job_title_id
        WHERE l.run_id = $1
          AND ($2::bool = FALSE OR NOT l.bank_account_registered)
          AND (
              $3::text IS NULL
              OR l.employee_display_name ILIKE '%' || $3 || '%' ESCAPE '\'
              OR COALESCE(e.employee_number, '') ILIKE '%' || $3 || '%' ESCAPE '\'
              OR COALESCE(NULLIF(ou.attributes->>'name', ''), NULLIF(e.org_unit, ''), '') ILIKE '%' || $3 || '%' ESCAPE '\'
              OR COALESCE(NULLIF(jt.label, ''), NULLIF(e.position, ''), '') ILIKE '%' || $3 || '%' ESCAPE '\'
          )
        "#,
    )
    .bind(run_id)
    .bind(missing_bank_only)
    .bind(search_pattern.as_deref())
    .fetch_one(tx.as_mut())
    .await?;

    let line_rows = sqlx::query(
        r#"
        SELECT l.id, l.employee_id, e.employee_number, l.employee_display_name, l.employee_company,
               COALESCE(NULLIF(ou.attributes->>'name', ''), NULLIF(e.org_unit, '')) AS org_unit,
               COALESCE(NULLIF(jt.label, ''), NULLIF(e.position, '')) AS position,
               l.work_days::float8 AS work_days,
               l.paid_holiday_days::float8 AS paid_holiday_days,
               l.regular_hours::float8 AS regular_hours,
               l.overtime_hours::float8 AS overtime_hours,
               l.night_hours::float8 AS night_hours,
               l.holiday_hours::float8 AS holiday_hours,
               l.leave_used::float8 AS leave_used,
               l.leave_remaining::float8 AS leave_remaining,
               l.gross_pay_source_present, l.net_pay_source_present,
               l.bank_account_registered,
               l.nts_tax_row_status, l.calculation_status, l.blockers,
               c.version AS calculation_version,
               c.base_pay_won,
               c.overtime_pay_won,
               c.meal_allowance_won,
               c.taxable_won,
               c.gross_won,
               c.deductions,
               c.total_deductions_won,
               c.net_won,
               c.tax_table_version
        FROM payroll_draft_lines l
        LEFT JOIN employees e ON e.org_id = l.org_id AND e.id = l.employee_id
        LEFT JOIN LATERAL (
            SELECT r.attributes
            FROM org_unit_revisions r
            WHERE r.org_id = e.org_id AND r.org_unit_id = e.org_unit_id
            ORDER BY r.version DESC
            LIMIT 1
        ) ou ON e.org_unit_id IS NOT NULL
        LEFT JOIN job_titles jt ON jt.org_id = e.org_id AND jt.id = e.job_title_id
        LEFT JOIN LATERAL (
            SELECT version, base_pay_won, overtime_pay_won, meal_allowance_won, taxable_won,
                   gross_won, deductions, total_deductions_won, net_won, tax_table_version
            FROM payroll_line_calculations
            WHERE org_id = l.org_id
              AND run_id = l.run_id
              AND line_id = l.id
              AND version = (
                  SELECT MAX(version)
                  FROM payroll_line_calculations
                  WHERE org_id = l.org_id AND run_id = l.run_id
              )
            ORDER BY version DESC
            LIMIT 1
        ) c ON TRUE
        WHERE l.run_id = $1
          AND ($4::bool = FALSE OR NOT l.bank_account_registered)
          AND (
              $5::text IS NULL
              OR l.employee_display_name ILIKE '%' || $5 || '%' ESCAPE '\'
              OR COALESCE(e.employee_number, '') ILIKE '%' || $5 || '%' ESCAPE '\'
              OR COALESCE(NULLIF(ou.attributes->>'name', ''), NULLIF(e.org_unit, ''), '') ILIKE '%' || $5 || '%' ESCAPE '\'
              OR COALESCE(NULLIF(jt.label, ''), NULLIF(e.position, ''), '') ILIKE '%' || $5 || '%' ESCAPE '\'
          )
        ORDER BY l.employee_company, l.employee_display_name, l.id
        LIMIT $2 OFFSET $3
        "#,
    )
    .bind(run_id)
    .bind(lines_limit)
    .bind(lines_offset)
    .bind(missing_bank_only)
    .bind(search_pattern.as_deref())
    .fetch_all(tx.as_mut())
    .await?;
    let lines = line_rows
        .iter()
        .map(line_summary_from_row)
        .collect::<Result<Vec<_>, PgPayrollError>>()?;

    let (exceptions_open, exceptions_total) = lifecycle::exception_counts_in_tx(tx, run_id).await?;
    let calculation = lifecycle::latest_calc_summary_in_tx(tx, run_id, run_lines_total).await?;
    let disbursement = lifecycle::get_disbursement_in_tx(tx, run_id).await?;
    let payslip_delivery = lifecycle::payslip_delivery_in_tx(tx, run_id, None, None)
        .await?
        .filter(|summary| summary.issued > 0);

    Ok(Some(PayrollRunDetail {
        run,
        legal_basis,
        source_summary,
        lines,
        lines_total,
        lines_limit,
        lines_offset,
        missing_bank_account_count,
        exceptions_open,
        exceptions_total,
        calculation,
        disbursement,
        payslip_delivery,
    }))
}
