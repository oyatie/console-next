//! Postgres adapter for the payroll draft-run staging tables (migration
//! 0074: `payroll_draft_runs`, `payroll_draft_lines`).
//!
//! Draft-run reads are *pre-calculation* readiness/staging data —
//! `payroll_draft_lines` stores work-day/hour counts and `*_source_present`
//! booleans, never a computed won amount. The real per-employee deduction
//! math lives in `console_payroll_domain::build_employee_payroll_draft`, which is
//! a pure in-memory function with no persistence anywhere in this schema.
//! Callers must not present draft readiness as an issued payslip.
//! Pay groups separately persist explicit legal-entity pay rules, without defaults.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

pub mod lifecycle;
pub mod pay_groups;
pub use pay_groups::run_preview::PayrollRunSummary;
/// `ObjectKey::PayRun`'s canonical write port, plus the one
/// `payroll_draft_runs` statement that used to live in
/// `console-workflow-runtime-adapter-postgres`.
pub mod pay_run;
pub mod payslip_draft;
pub mod reference;
pub mod roster;
mod run_detail;
pub use run_detail::{
    PayrollLineDeduction, PayrollLineSummary, PayrollRunDetail, get_run_filtered_in_tx,
    get_run_in_tx,
};
mod runs_read;
pub use runs_read::{list_runs_filtered_in_tx, list_runs_in_tx};

use console_kernel_core::{KernelError, UserId};
use console_platform_db::with_org_conn;
use console_platform_request_context::current_org;
use serde::Serialize;
use sqlx::{PgPool, Postgres, QueryBuilder, Row, Transaction};

use time::{Date, OffsetDateTime};
use uuid::Uuid;

mod error;
pub use error::PgPayrollError;

mod my_lines;
pub use my_lines::{MyPayrollLinePage, list_my_lines_in_tx};

const DEFAULT_LIMIT: i64 = 100;
const MAX_LIMIT: i64 = 500;

#[derive(Debug, Clone, Serialize)]
pub struct PayrollRunPage {
    pub items: Vec<PayrollRunSummary>,
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
}

/// A caller's own draft-line rows across runs (self-service). Readiness only:
/// hours and `*_source_present`. Never a `*_won` amount. Trimmed of the
/// admin-only source-import bookkeeping columns.
#[derive(Debug, Clone, Serialize)]
pub struct MyPayrollLine {
    pub run_id: Uuid,
    pub period_start: Date,
    pub period_end: Date,
    pub run_status: String,
    pub calculation_status: String,
    pub work_days: Option<f64>,
    pub regular_hours: Option<f64>,
    pub overtime_hours: Option<f64>,
    pub night_hours: Option<f64>,
    pub holiday_hours: Option<f64>,
    pub leave_used: Option<f64>,
    pub leave_remaining: Option<f64>,
    pub gross_pay_source_present: bool,
    pub net_pay_source_present: bool,
}

/// One SUBMITTED run visible to a distinct org-wide manager (inbox list only).
#[derive(Debug, Clone)]
pub struct PayrollActionInboxItem {
    pub id: Uuid,
    pub source_label: String,
    pub submitted_at: OffsetDateTime,
}

#[derive(Clone)]
pub struct PgPayrollStore {
    pool: PgPool,
}

impl std::fmt::Debug for PgPayrollStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PgPayrollStore").finish_non_exhaustive()
    }
}

impl PgPayrollStore {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Org-scoped page of payroll draft runs, newest period first.
    ///
    /// This opens its own transaction. A caller that must combine the read
    /// with an audited write in one atomic transaction (the REST layer's
    /// "others' reads are audited" requirement) should use
    /// [`list_runs_in_tx`] against an already-armed `tx` instead — e.g.
    /// inside `console_platform_db::with_audits`.
    pub async fn list_runs(
        &self,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> Result<PayrollRunPage, PgPayrollError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn::<_, _, PgPayrollError>(&self.pool, org, move |tx| {
            Box::pin(async move { list_runs_in_tx(tx, limit, offset).await })
        })
        .await
    }

    /// One run plus a page of its per-employee draft lines. `None` if the run
    /// doesn't exist (or belongs to another org — RLS makes the two
    /// indistinguishable, deny-by-omission).
    ///
    /// Opens its own transaction; see [`Self::list_runs`] on using
    /// [`get_run_in_tx`] instead for an atomic audited read.
    pub async fn get_run(
        &self,
        run_id: Uuid,
        lines_limit: Option<i64>,
        lines_offset: Option<i64>,
    ) -> Result<Option<PayrollRunDetail>, PgPayrollError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn::<_, _, PgPayrollError>(&self.pool, org, move |tx| {
            Box::pin(async move { get_run_in_tx(tx, run_id, lines_limit, lines_offset).await })
        })
        .await
    }

    /// The employee row linked to `user_id`, or `None` if the account has no
    /// link (mirrors `hr.rs::load_optional_linked_employee_id`).
    pub async fn linked_employee_id(
        &self,
        user_id: UserId,
    ) -> Result<Option<Uuid>, PgPayrollError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn::<_, _, PgPayrollError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let employee_id: Option<Uuid> =
                    sqlx::query_scalar("SELECT employee_id FROM users WHERE id = $1")
                        .bind(*user_id.as_uuid())
                        .fetch_optional(tx.as_mut())
                        .await?
                        .flatten();
                Ok(employee_id)
            })
        })
        .await
    }

    /// Self-scoped page of the caller's own draft-line rows across runs,
    /// newest run period first. `employee_id` must already be resolved from
    /// the authenticated principal (never accepted from client input).
    pub async fn list_my_lines(
        &self,
        employee_id: Uuid,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> Result<MyPayrollLinePage, PgPayrollError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn::<_, _, PgPayrollError>(&self.pool, org, move |tx| {
            Box::pin(list_my_lines_in_tx(tx, employee_id, limit, offset))
        })
        .await
    }

    /// Keyset page of SUBMITTED runs the caller did not submit.
    ///
    /// Capability (`PayrollRunManage` org-wide) is enforced by the inbox
    /// composition root; this query only applies the SoD and as-of predicates.
    pub async fn list_submitted_action_inbox_page(
        &self,
        caller: UserId,
        as_of: OffsetDateTime,
        after: Option<(Option<OffsetDateTime>, OffsetDateTime, String)>,
        limit: i64,
    ) -> Result<(Vec<PayrollActionInboxItem>, i64, bool), PgPayrollError> {
        let limit = limit.clamp(1, 200);
        let org = current_org().map_err(KernelError::from)?;
        let caller_id = *caller.as_uuid();
        with_org_conn::<_, _, PgPayrollError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let total: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM payroll_draft_runs \
                     WHERE status = 'SUBMITTED' \
                       AND submitted_by IS NOT NULL \
                       AND submitted_by <> $1 \
                       AND submitted_at IS NOT NULL \
                       AND submitted_at <= $2",
                )
                .bind(caller_id)
                .bind(as_of)
                .fetch_one(tx.as_mut())
                .await?;
                let mut query = QueryBuilder::<Postgres>::new(
                    "SELECT id, source_label, submitted_at \
                     FROM payroll_draft_runs \
                     WHERE status = 'SUBMITTED' \
                       AND submitted_by IS NOT NULL \
                       AND submitted_by <> ",
                );
                query
                    .push_bind(caller_id)
                    .push(" AND submitted_at IS NOT NULL AND submitted_at <= ")
                    .push_bind(as_of);
                console_platform_db::inbox::push_page(
                    &mut query,
                    "NULL::timestamptz",
                    "submitted_at",
                    "('payroll:' || id::text)",
                    after,
                    limit,
                );
                let rows = query.build().fetch_all(tx.as_mut()).await?;
                let has_more = i64::try_from(rows.len()).unwrap_or(0) > limit;
                let items = rows
                    .iter()
                    .take(usize::try_from(limit).unwrap_or(rows.len()))
                    .map(|row| {
                        Ok(PayrollActionInboxItem {
                            id: row.try_get("id")?,
                            source_label: row.try_get("source_label")?,
                            submitted_at: row.try_get("submitted_at")?,
                        })
                    })
                    .collect::<Result<Vec<_>, PgPayrollError>>()?;
                Ok((items, total, has_more))
            })
        })
        .await
    }

    /// Verify that an approver identity is visible in the current tenant.
    ///
    /// This is a read-only prerequisite for the future audited approval command.
    /// It intentionally performs no status update until the shared step-up,
    /// audit, immutable release-evidence, and issuance-artifact seams exist.
    pub async fn assert_approver_belongs_to_current_org(
        &self,
        approver: UserId,
    ) -> Result<(), PgPayrollError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn::<_, _, PgPayrollError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let exists: bool =
                    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
                        .bind(*approver.as_uuid())
                        .fetch_one(tx.as_mut())
                        .await?;
                if !exists {
                    return Err(KernelError::forbidden(
                        "payroll approver must belong to the current organization",
                    )
                    .into());
                }
                Ok(())
            })
        })
        .await
    }
}

pub(crate) fn run_summary_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<PayrollRunSummary, PgPayrollError> {
    Ok(PayrollRunSummary {
        id: row.try_get("id")?,
        legal_entity_id: row.try_get("legal_entity_id")?,
        pay_group_id: row.try_get("pay_group_id")?,
        kind: row.try_get("kind")?,
        attribution_month: row.try_get("attribution_month")?,
        pay_date: row.try_get("pay_date")?,
        period_start: row.try_get("period_start")?,
        period_end: row.try_get("period_end")?,
        variable_period_start: row.try_get("variable_period_start")?,
        variable_period_end: row.try_get("variable_period_end")?,
        source_label: row.try_get("source_label")?,
        status: row.try_get("status")?,
        calculation_enabled: row.try_get("calculation_enabled")?,
        created_by: row.try_get("created_by")?,
        approved_by: row.try_get("approved_by")?,
        approved_at: row.try_get("approved_at")?,
        close_receipt: row.try_get("close_receipt")?,
        submitted_by: row.try_get("submitted_by")?,
        submitted_at: row.try_get("submitted_at")?,
        decided_by: row.try_get("decided_by")?,
        decided_at: row.try_get("decided_at")?,
        decision_reason: row.try_get("decision_reason")?,
        approval_ref: row.try_get("approval_ref")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn my_line_from_row(row: &sqlx::postgres::PgRow) -> Result<MyPayrollLine, PgPayrollError> {
    Ok(MyPayrollLine {
        run_id: row.try_get("run_id")?,
        period_start: row.try_get("period_start")?,
        period_end: row.try_get("period_end")?,
        run_status: row.try_get("run_status")?,
        calculation_status: row.try_get("calculation_status")?,
        work_days: row.try_get("work_days")?,
        regular_hours: row.try_get("regular_hours")?,
        overtime_hours: row.try_get("overtime_hours")?,
        night_hours: row.try_get("night_hours")?,
        holiday_hours: row.try_get("holiday_hours")?,
        leave_used: row.try_get("leave_used")?,
        leave_remaining: row.try_get("leave_remaining")?,
        gross_pay_source_present: row.try_get("gross_pay_source_present")?,
        net_pay_source_present: row.try_get("net_pay_source_present")?,
    })
}
