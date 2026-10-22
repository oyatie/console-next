//! Exit-case list and lookup SQL (moved from `app/src/hr.rs`, R2-exits).

use console_kernel_core::{BranchScope, KernelError};
use sqlx::{Postgres, QueryBuilder};
use uuid::Uuid;

use crate::HrError;
use crate::exits::rows::exit_case_from_row;
use crate::exits::types::EmployeeExitCaseResponse;
use crate::scope_sql::push_branch_scope_column;

/// The exit-case read filters, applied identically to the count and the page.
#[derive(Default)]
pub struct ExitCaseFilters {
    pub employee_id: Option<Uuid>,
    pub case_id: Option<Uuid>,
    pub statuses: Vec<String>,
    pub search: Option<String>,
}

impl ExitCaseFilters {
    /// ` WHERE …` over an `employee_exit_cases c` query.
    pub fn push(&self, builder: &mut QueryBuilder<Postgres>, scope: &BranchScope) {
        builder.push(" WHERE ");
        push_branch_scope_column(builder, scope, "c.branch_id");
        if let Some(employee_id) = self.employee_id {
            builder.push(" AND c.employee_id = ");
            builder.push_bind(employee_id);
        }
        if let Some(case_id) = self.case_id {
            builder.push(" AND c.id = ");
            builder.push_bind(case_id);
        }
        if !self.statuses.is_empty() {
            builder.push(" AND c.status = ANY(");
            builder.push_bind(self.statuses.clone());
            builder.push(")");
        }
        if let Some(search) = self.search.as_deref() {
            let pattern = format!("%{search}%");
            builder.push(
                " AND EXISTS (SELECT 1 FROM employees se WHERE se.org_id = c.org_id \
                 AND se.id = c.employee_id AND (se.name ILIKE ",
            );
            builder.push_bind(pattern.clone());
            builder.push(" OR se.employee_number ILIKE ");
            builder.push_bind(pattern);
            builder.push("))");
        }
    }
}

pub async fn count_filtered_exit_cases(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    scope: &BranchScope,
    filters: &ExitCaseFilters,
) -> Result<i64, HrError> {
    let mut builder = QueryBuilder::<Postgres>::new("SELECT count(*) FROM employee_exit_cases c");
    filters.push(&mut builder, scope);
    Ok(builder.build_query_scalar().fetch_one(tx.as_mut()).await?)
}

pub async fn load_exit_cases(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    scope: &BranchScope,
    filters: &ExitCaseFilters,
    limit: i64,
    offset: i64,
) -> Result<Vec<EmployeeExitCaseResponse>, HrError> {
    let mut builder = QueryBuilder::<Postgres>::new(exit_case_select_sql());
    filters.push(&mut builder, scope);
    builder.push(" ORDER BY c.updated_at DESC, c.reported_at DESC, c.id DESC LIMIT ");
    builder.push_bind(limit);
    builder.push(" OFFSET ");
    builder.push_bind(offset);

    builder
        .build()
        .fetch_all(tx.as_mut())
        .await?
        .into_iter()
        .map(exit_case_from_row)
        .collect::<Result<Vec<_>, HrError>>()
}

pub async fn load_exit_case_by_id(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    case_id: Uuid,
) -> Result<EmployeeExitCaseResponse, HrError> {
    let mut builder = QueryBuilder::<Postgres>::new(exit_case_select_sql());
    builder.push(" WHERE c.org_id = ");
    builder.push_bind(org_uuid);
    builder.push(" AND c.id = ");
    builder.push_bind(case_id);

    let row = builder
        .build()
        .fetch_optional(tx.as_mut())
        .await?
        .ok_or_else(|| HrError::from_kernel(KernelError::not_found("exit case not found")))?;
    exit_case_from_row(row)
}

pub fn exit_case_select_sql() -> &'static str {
    r#"
    SELECT
        c.id,
        c.employee_id,
        e.name AS employee_name,
        e.employee_number,
        e.company,
        e.org_unit,
        e.worksite_name,
        c.branch_id,
        b.name AS branch_name,
        c.absence_alert_id,
        c.status,
        c.effective_exit_date::TEXT AS effective_exit_date,
        c.site_manager_note,
        c.exit_reason_code,
        COALESCE(rc.involuntary, false) AS involuntary,
        COALESCE(rc.notice_required, false) AS notice_required,
        c.dismissal_notice_reason,
        c.dismissal_notice_served_on::text AS dismissal_notice_served_on,
        c.dismissal_notice_method,
        c.dismissal_notice_evidence_ref,
        c.reported_by,
        c.reported_at,
        c.hr_confirmed_by,
        c.hr_confirmed_at,
        c.hq_confirmed_by,
        c.hq_confirmed_at,
        c.approval_submitted_by,
        c.approval_submitted_at,
        c.closed_by,
        c.closed_at,
        c.closed_reason,
        c.exit_lifecycle_event_id,
        (SELECT x.state FROM employee_lifecycle_events x
          WHERE x.id = c.exit_lifecycle_event_id AND x.org_id = c.org_id) AS exit_event_state,
        -- Actor display names, resolved within the tenant (users is RLS-scoped);
        -- null when the actor is unset or unknown.
        (SELECT u.display_name FROM users u WHERE u.id = c.reported_by) AS reported_by_name,
        (SELECT u.display_name FROM users u WHERE u.id = c.hr_confirmed_by) AS hr_confirmed_by_name,
        (SELECT u.display_name FROM users u WHERE u.id = c.hq_confirmed_by) AS hq_confirmed_by_name,
        (SELECT u.display_name FROM users u WHERE u.id = c.approval_submitted_by) AS approval_submitted_by_name,
        (SELECT u.display_name FROM users u WHERE u.id = c.closed_by) AS closed_by_name,
        p.id AS package_id,
        p.status AS package_status,
        p.service_days,
        p.average_wage_period_start::TEXT AS average_wage_period_start,
        p.average_wage_period_end::TEXT AS average_wage_period_end,
        p.average_wage_calendar_days,
        p.average_wage_total_won,
        p.average_daily_wage_milliwon,
        p.severance_pay_won,
        p.monthly_ordinary_wage_won,
        p.ordinary_daily_wage_won,
        p.statutory_daily_wage_milliwon,
        p.missing_source_fields,
        p.statutory_basis,
        p.insurance_loss_payload,
        p.approval_payload,
        p.certification_status,
        p.certified_package_digest,
        p.generated_at,
        p.submitted_by,
        p.submitted_at
    FROM employee_exit_cases c
    JOIN employees e
      ON e.id = c.employee_id
     AND e.org_id = c.org_id
    LEFT JOIN reason_codes rc ON rc.org_id = c.org_id AND rc.domain = 'exit_reason' AND rc.code = c.exit_reason_code
    LEFT JOIN branches b
      ON b.id = c.branch_id
     AND b.org_id = c.org_id
    LEFT JOIN employee_exit_settlement_packages p
      ON p.exit_case_id = c.id
     AND p.org_id = c.org_id
    "#
}
