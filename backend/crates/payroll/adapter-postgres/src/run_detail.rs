// SPDX-License-Identifier: LicenseRef-Proprietary
use console_platform_db::DbError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

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
    pub employee_display_name: String,
    pub employee_company: String,
    pub work_days: Option<f64>,
    pub regular_hours: Option<f64>,
    pub overtime_hours: Option<f64>,
    pub night_hours: Option<f64>,
    pub holiday_hours: Option<f64>,
    pub leave_used: Option<f64>,
    pub leave_remaining: Option<f64>,
    pub gross_pay_source_present: bool,
    pub net_pay_source_present: bool,
    pub nts_tax_row_status: String,
    pub calculation_status: String,
    pub blockers: Value,
    pub calculation_version: Option<i32>,
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
    let lines_limit = lines_limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let lines_offset = lines_offset.unwrap_or(0).max(0);

    let Some(run_row) = fetch_run_row(tx, run_id).await? else {
        return Ok(None);
    };
    let run = run_summary_from_row(&run_row)?;
    let legal_basis: Value = run_row.try_get("legal_basis")?;
    let source_summary: Value = run_row.try_get("source_summary")?;

    let lines_total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM payroll_draft_lines WHERE run_id = $1")
            .bind(run_id)
            .fetch_one(tx.as_mut())
            .await?;

    let line_rows = sqlx::query(
        r#"
        SELECT l.id, l.employee_id, l.employee_display_name, l.employee_company,
               l.work_days::float8 AS work_days,
               l.regular_hours::float8 AS regular_hours,
               l.overtime_hours::float8 AS overtime_hours,
               l.night_hours::float8 AS night_hours,
               l.holiday_hours::float8 AS holiday_hours,
               l.leave_used::float8 AS leave_used,
               l.leave_remaining::float8 AS leave_remaining,
               l.gross_pay_source_present, l.net_pay_source_present,
               l.nts_tax_row_status, l.calculation_status, l.blockers,
               c.version AS calculation_version,
               c.gross_won,
               c.deductions,
               c.total_deductions_won,
               c.net_won,
               c.tax_table_version
        FROM payroll_draft_lines l
        LEFT JOIN LATERAL (
            SELECT version, gross_won, deductions, total_deductions_won, net_won, tax_table_version
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
        ORDER BY l.employee_company, l.employee_display_name, l.id
        LIMIT $2 OFFSET $3
        "#,
    )
    .bind(run_id)
    .bind(lines_limit)
    .bind(lines_offset)
    .fetch_all(tx.as_mut())
    .await?;
    let lines = line_rows
        .iter()
        .map(line_summary_from_row)
        .collect::<Result<Vec<_>, PgPayrollError>>()?;

    let (exceptions_open, exceptions_total) = lifecycle::exception_counts_in_tx(tx, run_id).await?;
    let calculation = lifecycle::latest_calc_summary_in_tx(tx, run_id, lines_total).await?;
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
        exceptions_open,
        exceptions_total,
        calculation,
        disbursement,
        payslip_delivery,
    }))
}

pub(crate) async fn fetch_run_row(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
) -> Result<Option<sqlx::postgres::PgRow>, PgPayrollError> {
    Ok(sqlx::query(
        r#"
        SELECT r.id, g.legal_entity_id, r.pay_group_id, r.kind,
               to_char(r.attribution_month, 'YYYY-MM') AS attribution_month,
               r.pay_date, r.period_start, r.period_end,
               r.variable_period_start, r.variable_period_end,
               r.source_label, r.status, r.calculation_enabled, r.created_by,
               r.approved_by, r.approved_at, r.close_receipt, r.submitted_by,
               r.submitted_at, r.decided_by, r.decided_at, r.decision_reason,
               r.approval_ref, r.created_at, r.updated_at, r.legal_basis, r.source_summary
        FROM payroll_draft_runs r
        LEFT JOIN pay_groups g ON g.org_id=r.org_id AND g.id=r.pay_group_id
        WHERE r.id = $1
        "#,
    )
    .bind(run_id)
    .fetch_optional(tx.as_mut())
    .await?)
}

fn line_summary_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<PayrollLineSummary, PgPayrollError> {
    let raw_deductions: Option<Value> = row.try_get("deductions")?;
    let deductions = raw_deductions
        .map(serde_json::from_value::<Vec<PayrollLineDeduction>>)
        .transpose()
        .map_err(DbError::Serialize)?;
    Ok(PayrollLineSummary {
        id: row.try_get("id")?,
        employee_id: row.try_get("employee_id")?,
        employee_display_name: row.try_get("employee_display_name")?,
        employee_company: row.try_get("employee_company")?,
        work_days: row.try_get("work_days")?,
        regular_hours: row.try_get("regular_hours")?,
        overtime_hours: row.try_get("overtime_hours")?,
        night_hours: row.try_get("night_hours")?,
        holiday_hours: row.try_get("holiday_hours")?,
        leave_used: row.try_get("leave_used")?,
        leave_remaining: row.try_get("leave_remaining")?,
        gross_pay_source_present: row.try_get("gross_pay_source_present")?,
        net_pay_source_present: row.try_get("net_pay_source_present")?,
        nts_tax_row_status: row.try_get("nts_tax_row_status")?,
        calculation_status: row.try_get("calculation_status")?,
        blockers: row.try_get("blockers")?,
        calculation_version: row.try_get("calculation_version")?,
        gross_won: row.try_get("gross_won")?,
        deductions,
        total_deductions_won: row.try_get("total_deductions_won")?,
        net_won: row.try_get("net_won")?,
        tax_table_version: row.try_get("tax_table_version")?,
    })
}
