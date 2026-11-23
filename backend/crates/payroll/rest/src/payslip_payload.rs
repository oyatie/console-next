// SPDX-License-Identifier: LicenseRef-Proprietary
use console_payroll_adapter_postgres::lifecycle::{IssuanceLine, RunHead};
use serde_json::{Value, json};
use uuid::Uuid;

pub(crate) fn build(run_id: Uuid, run: &RunHead, line: &IssuanceLine) -> Value {
    json!({
        "run_id": run_id,
        "line_id": line.line_id,
        "attribution_month": run.attribution_month,
        "period_start": run.period_start.to_string(),
        "period_end": run.period_end.to_string(),
        "pay_date": run.pay_date.map(|d| d.to_string()),
        "employee_number": line.employee_number,
        "employee_display_name": line.employee_display_name,
        "employee_company": line.employee_company,
        "org_unit": line.org_unit,
        "position": line.position,
        "work_days": line.work_days,
        "paid_holiday_days": line.paid_holiday_days,
        "regular_hours": line.regular_hours,
        "overtime_hours": line.overtime_hours,
        "night_hours": line.night_hours,
        "holiday_hours": line.holiday_hours,
        "leave_used": line.leave_used,
        "leave_remaining": line.leave_remaining,
        "bank_account_registered": line.bank_account_registered,
        "base_pay_won": line.base_pay_won,
        "overtime_pay_won": line.overtime_pay_won,
        "meal_allowance_won": line.meal_allowance_won,
        "taxable_won": line.taxable_won,
        "gross_won": line.gross_won,
        "deductions": line.deductions,
        "total_deductions_won": line.total_deductions_won,
        "net_won": line.net_won,
        "tax_table_version": line.tax_table_version,
        "calculation_version": line.version,
    })
}
