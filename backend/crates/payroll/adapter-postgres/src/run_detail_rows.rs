// SPDX-License-Identifier: LicenseRef-Proprietary
use console_platform_db::DbError;
use serde_json::Value;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

use super::{PayrollLineDeduction, PayrollLineSummary};
use crate::PgPayrollError;

pub(super) fn escape_like(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
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
               r.variable_period_start, r.variable_period_end, r.attendance_cutoff_date,
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

pub(super) fn line_summary_from_row(
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
        employee_number: row.try_get("employee_number")?,
        employee_display_name: row.try_get("employee_display_name")?,
        employee_company: row.try_get("employee_company")?,
        org_unit: row.try_get("org_unit")?,
        position: row.try_get("position")?,
        work_days: row.try_get("work_days")?,
        paid_holiday_days: row.try_get("paid_holiday_days")?,
        regular_hours: row.try_get("regular_hours")?,
        overtime_hours: row.try_get("overtime_hours")?,
        night_hours: row.try_get("night_hours")?,
        holiday_hours: row.try_get("holiday_hours")?,
        leave_used: row.try_get("leave_used")?,
        leave_remaining: row.try_get("leave_remaining")?,
        gross_pay_source_present: row.try_get("gross_pay_source_present")?,
        net_pay_source_present: row.try_get("net_pay_source_present")?,
        bank_account_registered: row.try_get("bank_account_registered")?,
        nts_tax_row_status: row.try_get("nts_tax_row_status")?,
        calculation_status: row.try_get("calculation_status")?,
        blockers: row.try_get("blockers")?,
        calculation_version: row.try_get("calculation_version")?,
        base_pay_won: row.try_get("base_pay_won")?,
        overtime_pay_won: row.try_get("overtime_pay_won")?,
        meal_allowance_won: row.try_get("meal_allowance_won")?,
        taxable_won: row.try_get("taxable_won")?,
        gross_won: row.try_get("gross_won")?,
        deductions,
        total_deductions_won: row.try_get("total_deductions_won")?,
        net_won: row.try_get("net_won")?,
        tax_table_version: row.try_get("tax_table_version")?,
    })
}
