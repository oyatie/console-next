// SPDX-License-Identifier: LicenseRef-Proprietary
use console_payroll_domain::payroll_sources_verified_on;
use serde_json::Value;
use sqlx::{Postgres, Row, Transaction};
use time::Date;
use uuid::Uuid;

use super::{LifecycleError, RunCalcSummary, validate_run_release_gate};

/// One deliverable line for payslip issuance: the latest stored calculation
/// joined to the employee's linked user account and draft-line attendance.
#[derive(Debug, Clone)]
pub struct IssuanceLine {
    pub line_id: Uuid,
    pub employee_id: Uuid,
    pub employee_number: Option<String>,
    pub employee_display_name: String,
    pub employee_company: String,
    pub org_unit: Option<String>,
    pub position: Option<String>,
    pub recipient_user_id: Uuid,
    pub version: i32,
    pub base_pay_won: Option<i64>,
    pub overtime_pay_won: Option<i64>,
    pub meal_allowance_won: Option<i64>,
    pub taxable_won: Option<i64>,
    pub gross_won: i64,
    pub deductions: Value,
    pub total_deductions_won: i64,
    pub net_won: i64,
    pub tax_table_version: String,
    pub work_days: Option<f64>,
    pub paid_holiday_days: Option<f64>,
    pub regular_hours: Option<f64>,
    pub overtime_hours: Option<f64>,
    pub night_hours: Option<f64>,
    pub holiday_hours: Option<f64>,
    pub leave_used: Option<f64>,
    pub leave_remaining: Option<f64>,
    pub bank_account_registered: bool,
}

#[derive(Debug, Clone)]
pub struct RunHead {
    pub id: Uuid,
    pub pay_group_id: Option<Uuid>,
    pub attribution_month: Option<String>,
    pub period_start: Date,
    pub period_end: Date,
    pub pay_date: Option<Date>,
    pub source_label: String,
    pub status: String,
    pub submitted_by: Option<Uuid>,
    pub legal_basis: Value,
}

pub(super) async fn run_head(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
    for_update: bool,
) -> Result<Option<RunHead>, LifecycleError> {
    let sql_locked = "SELECT id, pay_group_id, to_char(attribution_month, 'YYYY-MM') AS attribution_month, \
         period_start, period_end, pay_date, source_label, status, \
         submitted_by, legal_basis FROM payroll_draft_runs WHERE id = $1 FOR UPDATE";
    let sql_plain = "SELECT id, pay_group_id, to_char(attribution_month, 'YYYY-MM') AS attribution_month, \
         period_start, period_end, pay_date, source_label, status, \
         submitted_by, legal_basis FROM payroll_draft_runs WHERE id = $1";
    let row = sqlx::query(if for_update { sql_locked } else { sql_plain })
        .bind(run_id)
        .fetch_optional(tx.as_mut())
        .await?;
    row.map(|row| {
        Ok(RunHead {
            id: row.try_get("id")?,
            pay_group_id: row.try_get("pay_group_id")?,
            attribution_month: row.try_get("attribution_month")?,
            period_start: row.try_get("period_start")?,
            period_end: row.try_get("period_end")?,
            pay_date: row.try_get("pay_date")?,
            source_label: row.try_get("source_label")?,
            status: row.try_get("status")?,
            submitted_by: row.try_get("submitted_by")?,
            legal_basis: row.try_get("legal_basis")?,
        })
    })
    .transpose()
}

pub(super) fn invalid_state(action: &str, status: &str) -> LifecycleError {
    LifecycleError::InvalidState(format!("cannot {action} a run in status {status}"))
}

/// Aggregate of the latest calculation version for a run, or `None` if the
/// run was never calculated.
pub async fn latest_calc_summary_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
    lines_total: i64,
) -> Result<Option<RunCalcSummary>, LifecycleError> {
    let row = sqlx::query(
        "SELECT version, MAX(created_at) AS calculated_at, COUNT(*)::BIGINT AS calculated_lines, \
                BOOL_AND(payable) AS payable, SUM(gross_won)::BIGINT AS gross_sum, \
                SUM(total_deductions_won)::BIGINT AS deductions_sum, \
                SUM(net_won)::BIGINT AS net_sum \
         FROM payroll_line_calculations \
         WHERE run_id = $1 \
           AND version = (SELECT MAX(version) FROM payroll_line_calculations WHERE run_id = $1) \
         GROUP BY version",
    )
    .bind(run_id)
    .fetch_optional(tx.as_mut())
    .await?;
    row.map(|row| {
        let calculated_lines: i64 = row.try_get("calculated_lines")?;
        let all_calculated = calculated_lines == lines_total;
        let gross_sum: Option<i64> = row.try_get("gross_sum")?;
        let deductions_sum: Option<i64> = row.try_get("deductions_sum")?;
        let net_sum: Option<i64> = row.try_get("net_sum")?;
        Ok(RunCalcSummary {
            version: row.try_get("version")?,
            calculated_at: row.try_get("calculated_at")?,
            calculated_lines,
            blocked_lines: (lines_total - calculated_lines).max(0),
            payable: row.try_get("payable")?,
            kernel_rate_table: format!("statutory-rates-{}", payroll_sources_verified_on()),
            total_gross_won: if all_calculated { gross_sum } else { None },
            total_deductions_won: if all_calculated { deductions_sum } else { None },
            total_net_won: if all_calculated { net_sum } else { None },
        })
    })
    .transpose()
}

/// Collect the latest calculation per line alongside the linked user account
/// for a PAID run whose professional release gate validates. Refuses on empty
/// deliverable sets (issuing nothing is not issuance).
pub async fn load_payslip_issuance_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
) -> Result<(RunHead, Vec<IssuanceLine>), LifecycleError> {
    let Some(run) = run_head(tx, run_id, false).await? else {
        return Err(LifecycleError::NotFound);
    };
    if run.status != "PAID" {
        return Err(invalid_state("issue payslips for", &run.status));
    }
    validate_run_release_gate(&run.legal_basis)?;
    let rows = sqlx::query(
        "SELECT DISTINCT ON (c.line_id) c.line_id, c.version, \
                c.base_pay_won, c.overtime_pay_won, c.meal_allowance_won, c.taxable_won, \
                c.gross_won, c.deductions, c.total_deductions_won, c.net_won, c.tax_table_version, \
                l.employee_id, e.employee_number, l.employee_display_name, l.employee_company, \
                COALESCE(NULLIF(ou.attributes->>'name', ''), NULLIF(e.org_unit, '')) AS org_unit, \
                COALESCE(NULLIF(jt.label, ''), NULLIF(e.position, '')) AS position, \
                l.work_days::float8 AS work_days, \
                l.paid_holiday_days::float8 AS paid_holiday_days, \
                l.regular_hours::float8 AS regular_hours, \
                l.overtime_hours::float8 AS overtime_hours, \
                l.night_hours::float8 AS night_hours, \
                l.holiday_hours::float8 AS holiday_hours, \
                l.leave_used::float8 AS leave_used, \
                l.leave_remaining::float8 AS leave_remaining, \
                l.bank_account_registered, \
                u.id AS recipient_user_id \
         FROM payroll_line_calculations c \
         JOIN payroll_draft_lines l ON l.org_id = c.org_id AND l.id = c.line_id \
         LEFT JOIN users u ON u.org_id = l.org_id AND u.employee_id = l.employee_id \
         LEFT JOIN employees e ON e.org_id = l.org_id AND e.id = l.employee_id \
         LEFT JOIN LATERAL ( \
             SELECT r.attributes \
             FROM org_unit_revisions r \
             WHERE r.org_id = e.org_id AND r.org_unit_id = e.org_unit_id \
             ORDER BY r.version DESC \
             LIMIT 1 \
         ) ou ON e.org_unit_id IS NOT NULL \
         LEFT JOIN job_titles jt ON jt.org_id = e.org_id AND jt.id = e.job_title_id \
         WHERE c.run_id = $1 \
         ORDER BY c.line_id, c.version DESC",
    )
    .bind(run_id)
    .fetch_all(tx.as_mut())
    .await?;
    let mut missing = 0;
    for row in &rows {
        if row
            .try_get::<Option<Uuid>, _>("recipient_user_id")?
            .is_none()
        {
            missing += 1;
        }
    }
    if missing > 0 {
        return Err(LifecycleError::InvalidState(format!(
            "{missing} calculated payroll line(s) lack a linked recipient"
        )));
    }
    let lines =
        rows.iter()
            .map(|row| {
                Ok(IssuanceLine {
                    line_id: row.try_get("line_id")?,
                    employee_id: row.try_get::<Option<Uuid>, _>("employee_id")?.ok_or_else(
                        || LifecycleError::Validation("issuance line lost its employee".to_owned()),
                    )?,
                    employee_number: row.try_get("employee_number")?,
                    employee_display_name: row.try_get("employee_display_name")?,
                    employee_company: row.try_get("employee_company")?,
                    org_unit: row.try_get("org_unit")?,
                    position: row.try_get("position")?,
                    recipient_user_id: row.try_get("recipient_user_id")?,
                    version: row.try_get("version")?,
                    base_pay_won: row.try_get("base_pay_won")?,
                    overtime_pay_won: row.try_get("overtime_pay_won")?,
                    meal_allowance_won: row.try_get("meal_allowance_won")?,
                    taxable_won: row.try_get("taxable_won")?,
                    gross_won: row.try_get("gross_won")?,
                    deductions: row.try_get("deductions")?,
                    total_deductions_won: row.try_get("total_deductions_won")?,
                    net_won: row.try_get("net_won")?,
                    tax_table_version: row.try_get("tax_table_version")?,
                    work_days: row.try_get("work_days")?,
                    paid_holiday_days: row.try_get("paid_holiday_days")?,
                    regular_hours: row.try_get("regular_hours")?,
                    overtime_hours: row.try_get("overtime_hours")?,
                    night_hours: row.try_get("night_hours")?,
                    holiday_hours: row.try_get("holiday_hours")?,
                    leave_used: row.try_get("leave_used")?,
                    leave_remaining: row.try_get("leave_remaining")?,
                    bank_account_registered: row.try_get("bank_account_registered")?,
                })
            })
            .collect::<Result<Vec<_>, LifecycleError>>()?;
    if lines.is_empty() {
        return Err(LifecycleError::InvalidState(
            "no calculated line with a linked user account exists to issue payslips for".to_owned(),
        ));
    }
    Ok((run, lines))
}
