//! Run-lifecycle writes for the payroll console (migration 0186):
//! close → calculate → exception review → SoD approval → operator-attested
//! disbursement → release-gated payslip issuance.
//!
//! Every function here takes an already-armed transaction (the REST layer
//! wraps each mutation in `console_platform_db::with_audits`, which binds
//! `app.current_org` before the closure runs), so Postgres RLS scopes every
//! statement. `Option::None` / [`LifecycleError::NotFound`] is returned for a
//! run that does not exist OR belongs to another org — RLS makes the two
//! indistinguishable (deny-by-omission).
//!
//! # Truthfulness invariants
//! - A per-line calculation is attempted ONLY when the readiness row says
//!   `gross_pay_source_present && nts_tax_row_status = 'VERIFIED_SOURCE_ROW'`
//!   AND the linked immutable source ledger rows
//!   (`data_import_rows.canonical_row.payroll`) actually carry the figures.
//!   Anything else records a truthful blocker; income tax is never estimated.
//! - Stored calculations are always drafts (`payable = FALSE`); nothing here
//!   flips that flag — only the labor attorney/tax accountant release gate
//!   charter may.
//! - Disbursement statuses are operator attestations (no bank API exists).
//! - Payslip issuance is hard-gated by
//!   [`console_payroll_domain::validate_release_gate`] over the release-gate
//!   record registered in `payroll_draft_runs.legal_basis.release_gate`;
//!   an unregistered gate is a 409, never a fake payslip.

use console_payroll_domain::{
    DeductionCode, GoldenPayrollCase, LineCalculationInput, PayrollReleaseGateInput,
    ProfessionalReviewerKind, ProfessionalValidation, VerifiedNtsTaxRow, build_line_calculation,
    validate_release_gate,
};
#[path = "lifecycle_amounts.rs"]
mod amounts;
use amounts::{SourceAmounts, insert_line_calculation_in_tx, select_source_amounts};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use time::format_description::well_known::Iso8601;
use time::{Date, OffsetDateTime};
use uuid::Uuid;

const DEFAULT_LIMIT: i64 = 100;
const MAX_LIMIT: i64 = 500;
/// Cap on per-check blocking refs returned by the preflight (the note carries
/// the full count).
const PREFLIGHT_REF_CAP: i64 = 50;

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct PreflightCheck {
    pub key: &'static str,
    pub label_ko: &'static str,
    pub ok: bool,
    pub warn: bool,
    pub note: Option<String>,
    pub blocking_refs: Vec<Uuid>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClosePreflight {
    pub checks: Vec<PreflightCheck>,
    pub can_close: bool,
}

mod dto;
pub use dto::RunCalcSummary;
mod issuance;
pub use issuance::{IssuanceLine, RunHead, latest_calc_summary_in_tx, load_payslip_issuance_in_tx};
use issuance::{invalid_state, run_head};

#[derive(Debug, Clone, Serialize)]
pub struct PayrollException {
    pub id: Uuid,
    pub run_id: Uuid,
    pub line_id: Option<Uuid>,
    pub employee_id: Option<Uuid>,
    pub employee_display_name: String,
    pub kind: String,
    pub severity: String,
    pub amount_delta_won: Option<i64>,
    pub summary_ko: String,
    pub detail: Value,
    pub linked_refs: Value,
    pub status: String,
    pub resolved_by: Option<Uuid>,
    #[serde(with = "console_kernel_core::timestamp::option")]
    pub resolved_at: Option<OffsetDateTime>,
    pub resolved_reason: Option<String>,
    pub carried_from_run_id: Option<Uuid>,
    #[serde(with = "console_kernel_core::timestamp")]
    pub created_at: OffsetDateTime,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExceptionPage {
    pub items: Vec<PayrollException>,
    pub total: i64,
    pub open: i64,
    pub limit: i64,
    pub offset: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Disbursement {
    pub id: Uuid,
    pub run_id: Uuid,
    #[serde(with = "console_kernel_core::timestamp")]
    pub scheduled_at: OffsetDateTime,
    pub status: String,
    pub attested_by: Option<Uuid>,
    #[serde(with = "console_kernel_core::timestamp::option")]
    pub attested_at: Option<OffsetDateTime>,
    pub reason: Option<String>,
    #[serde(with = "console_kernel_core::timestamp")]
    pub created_at: OffsetDateTime,
    #[serde(with = "console_kernel_core::timestamp")]
    pub updated_at: OffsetDateTime,
}

#[derive(Debug, Clone, Serialize)]
pub struct PayslipDeliveryItem {
    pub line_id: Uuid,
    pub employee_id: Uuid,
    pub inbox_doc_id: Uuid,
    #[serde(with = "console_kernel_core::timestamp")]
    pub issued_at: OffsetDateTime,
    /// Read back from `inbox_docs.confirmed_at`. The vault currently only
    /// permits receipt confirmation on `legal_notice` documents, so payslip
    /// acknowledgement stays `None` until that vault capability lands —
    /// reported truthfully rather than simulated.
    #[serde(with = "console_kernel_core::timestamp::option")]
    pub acknowledged_at: Option<OffsetDateTime>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PayslipDeliverySummary {
    pub run_id: Uuid,
    pub issued: i64,
    pub acknowledged: i64,
    pub items: Vec<PayslipDeliveryItem>,
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
}

#[derive(Debug, Clone)]
pub struct CalculationOutcome {
    pub version: i32,
    pub calculated_lines: i64,
    pub blocked_lines: i64,
    pub exceptions_created: i64,
}

#[path = "lifecycle_error.rs"]
mod error;
pub use error::LifecycleError;

// ---------------------------------------------------------------------------
// Close preflight + close
// ---------------------------------------------------------------------------

mod close;
pub use close::{close_attendance_in_tx, close_preflight_in_tx};

fn json_internal(err: serde_json::Error) -> LifecycleError {
    LifecycleError::Validation(format!("failed to serialize receipt: {err}"))
}

// ---------------------------------------------------------------------------
// Calculation
// ---------------------------------------------------------------------------

const fn deduction_code_str(code: DeductionCode) -> &'static str {
    match code {
        DeductionCode::NationalPension => "NATIONAL_PENSION",
        DeductionCode::HealthInsurance => "HEALTH_INSURANCE",
        DeductionCode::LongTermCare => "LONG_TERM_CARE",
        DeductionCode::EmploymentInsurance => "EMPLOYMENT_INSURANCE",
        DeductionCode::IncomeTax => "INCOME_TAX",
        DeductionCode::LocalIncomeTax => "LOCAL_INCOME_TAX",
    }
}

pub async fn calculate_run_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
) -> Result<CalculationOutcome, LifecycleError> {
    let Some(run) = run_head(tx, run_id, true).await? else {
        return Err(LifecycleError::NotFound);
    };
    if run.status != "ATTENDANCE_CLOSED" {
        return Err(invalid_state("calculate", &run.status));
    }
    // The transient state is real: any concurrent reader inside this
    // transaction window sees CALCULATING.
    sqlx::query(
        "UPDATE payroll_draft_runs SET status = 'CALCULATING', updated_at = now() WHERE id = $1",
    )
    .bind(run_id)
    .execute(tx.as_mut())
    .await?;

    let version: i32 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(version), 0) + 1 FROM payroll_line_calculations WHERE run_id = $1",
    )
    .bind(run_id)
    .fetch_one(tx.as_mut())
    .await?;

    let lines = sqlx::query(
        "SELECT id, employee_id, employee_display_name, gross_pay_source_present, \
                nts_tax_row_status, overtime_hours::float8 AS overtime_hours, \
                source_data_import_row_ids \
         FROM payroll_draft_lines WHERE run_id = $1 AND calculation_status <> 'VOID' \
         ORDER BY employee_company, employee_display_name, id FOR UPDATE",
    )
    .bind(run_id)
    .fetch_all(tx.as_mut())
    .await?;

    let mut calculated: i64 = 0;
    let mut blocked: i64 = 0;
    let mut exceptions_created: i64 = 0;

    for row in &lines {
        let line_id: Uuid = row.try_get("id")?;
        let employee_id: Option<Uuid> = row.try_get("employee_id")?;
        let display_name: String = row.try_get("employee_display_name")?;
        let gross_present: bool = row.try_get("gross_pay_source_present")?;
        let nts_status: String = row.try_get("nts_tax_row_status")?;
        let overtime_hours: Option<f64> = row.try_get("overtime_hours")?;
        let import_row_ids: Vec<Uuid> = row.try_get("source_data_import_row_ids")?;

        let mut blockers: Vec<String> = Vec::new();
        if !gross_present {
            blockers.push("GROSS_PAY_SOURCE_MISSING".to_owned());
        }
        if nts_status != "VERIFIED_SOURCE_ROW" {
            blockers.push("NTS_TAX_ROW_UNVERIFIED".to_owned());
        }

        let mut amounts: Option<SourceAmounts> = None;
        if blockers.is_empty() {
            let canonical_rows: Vec<Value> = if import_row_ids.is_empty() {
                Vec::new()
            } else {
                sqlx::query_scalar("SELECT canonical_row FROM data_import_rows WHERE id = ANY($1)")
                    .bind(&import_row_ids)
                    .fetch_all(tx.as_mut())
                    .await?
            };
            // The readiness flags promised a verified source; if the linked
            // ledger rows carry no payroll figures (NOT_MATERIALIZED) or two
            // different figure sets (CONFLICTING), that is a truthful blocker
            // — never an estimate, never an arbitrary pick.
            match select_source_amounts(&canonical_rows) {
                Ok(selected) => amounts = Some(selected),
                Err(blocker) => blockers.push(blocker.to_owned()),
            }
        }

        if let Some(amounts) = amounts {
            let breakdown = [
                amounts.base_pay_won,
                amounts.overtime_pay_won,
                amounts.meal_allowance_won,
                amounts.taxable_won,
            ];
            match build_line_calculation(LineCalculationInput {
                pay_date: run.period_end,
                gross_won: amounts.gross_won,
                pension_standard_monthly_income_won: amounts.pension_standard_monthly_income_won,
                tax_row: amounts.tax_row,
            }) {
                Ok(calc) => {
                    let deductions: Vec<Value> = calc
                        .lines
                        .iter()
                        .map(|line| {
                            json!({
                                "code": deduction_code_str(line.code),
                                "label_ko": line.label_ko,
                                "amount_won": line.amount_won,
                                "source_url": line.source_url,
                            })
                        })
                        .collect();
                    insert_line_calculation_in_tx(
                        tx,
                        line_id,
                        version,
                        calc.gross_won,
                        &deductions,
                        calc.total_employee_deductions_won,
                        calc.net_won,
                        &calc.tax_table_version,
                        breakdown,
                    )
                    .await?;
                    calculated += 1;
                    sqlx::query(
                        "UPDATE payroll_draft_lines SET calculation_status = 'READY_FOR_REVIEW', \
                         blockers = '[]'::jsonb, updated_at = now() WHERE id = $1",
                    )
                    .bind(line_id)
                    .execute(tx.as_mut())
                    .await?;
                }
                Err(err) => {
                    blockers.push(format!("CALCULATION_REJECTED: {}", err.message));
                    blocked += 1;
                    write_line_blockers(tx, line_id, &blockers).await?;
                }
            }
        } else {
            blocked += 1;
            write_line_blockers(tx, line_id, &blockers).await?;
        }

        // Real attendance-derived signal: overtime hours on the roster line
        // mean the overtime allowance must be confirmed against the gross
        // source. The delta is NOT derivable from a verified source, so it
        // stays NULL.
        if overtime_hours.unwrap_or(0.0) > 0.0 {
            let inserted = sqlx::query(
                "INSERT INTO payroll_run_exceptions \
                 (org_id, run_id, line_id, employee_id, employee_display_name, kind, severity, \
                  amount_delta_won, summary_ko, detail, linked_refs) \
                 SELECT l.org_id, l.run_id, l.id, l.employee_id, l.employee_display_name, \
                        'OVERTIME_ALLOWANCE', 'warn', NULL, $2, $3, $4 \
                 FROM payroll_draft_lines l WHERE l.id = $1 \
                 ON CONFLICT (org_id, run_id, line_id, kind) WHERE line_id IS NOT NULL \
                 DO NOTHING",
            )
            .bind(line_id)
            .bind(format!(
                "연장 {:.1}시간 — 연장수당 반영 확인 필요",
                overtime_hours.unwrap_or(0.0)
            ))
            .bind(json!({ "overtime_hours": overtime_hours }))
            .bind(json!([
                { "kind": "payroll_line", "code": display_name, "id": line_id },
                { "kind": "employee", "code": display_name, "id": employee_id },
            ]))
            .execute(tx.as_mut())
            .await?;
            exceptions_created += i64::try_from(inserted.rows_affected()).unwrap_or(0);
        }
    }

    // Carry-forward: HELD exceptions from the previous run of the same series
    // are re-opened on this run (carried_from_run_id keeps the lineage).
    let carried = sqlx::query(
        "INSERT INTO payroll_run_exceptions \
         (org_id, run_id, line_id, employee_id, employee_display_name, kind, severity, \
          amount_delta_won, summary_ko, detail, linked_refs, carried_from_run_id) \
         SELECT e.org_id, $1, NULL, e.employee_id, e.employee_display_name, e.kind, \
                e.severity, e.amount_delta_won, e.summary_ko, e.detail, e.linked_refs, e.run_id \
         FROM payroll_run_exceptions e \
         WHERE e.status = 'HELD' \
           AND e.run_id = (SELECT r.id FROM payroll_draft_runs r \
                           WHERE r.source_label = $2 AND r.period_end < $3 \
                           ORDER BY r.period_end DESC LIMIT 1) \
           AND NOT EXISTS (SELECT 1 FROM payroll_run_exceptions x \
                           WHERE x.run_id = $1 AND x.carried_from_run_id = e.run_id \
                             AND x.kind = e.kind \
                             AND x.employee_id IS NOT DISTINCT FROM e.employee_id)",
    )
    .bind(run_id)
    .bind(&run.source_label)
    .bind(run.period_start)
    .execute(tx.as_mut())
    .await?;
    exceptions_created += i64::try_from(carried.rows_affected()).unwrap_or(0);

    sqlx::query(
        "UPDATE payroll_draft_runs SET status = 'CALCULATED', updated_at = now() WHERE id = $1",
    )
    .bind(run_id)
    .execute(tx.as_mut())
    .await?;

    Ok(CalculationOutcome {
        version,
        calculated_lines: calculated,
        blocked_lines: blocked,
        exceptions_created,
    })
}

async fn write_line_blockers(
    tx: &mut Transaction<'_, Postgres>,
    line_id: Uuid,
    blockers: &[String],
) -> Result<(), LifecycleError> {
    sqlx::query(
        "UPDATE payroll_draft_lines SET calculation_status = 'BLOCKED_LEGAL_GATE', \
         blockers = $2, updated_at = now() WHERE id = $1",
    )
    .bind(line_id)
    .bind(serde_json::to_value(blockers).map_err(json_internal)?)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

fn exception_from_row(row: &sqlx::postgres::PgRow) -> Result<PayrollException, LifecycleError> {
    Ok(PayrollException {
        id: row.try_get("id")?,
        run_id: row.try_get("run_id")?,
        line_id: row.try_get("line_id")?,
        employee_id: row.try_get("employee_id")?,
        employee_display_name: row.try_get("employee_display_name")?,
        kind: row.try_get("kind")?,
        severity: row.try_get("severity")?,
        amount_delta_won: row.try_get("amount_delta_won")?,
        summary_ko: row.try_get("summary_ko")?,
        detail: row.try_get("detail")?,
        linked_refs: row.try_get("linked_refs")?,
        status: row.try_get("status")?,
        resolved_by: row.try_get("resolved_by")?,
        resolved_at: row.try_get("resolved_at")?,
        resolved_reason: row.try_get("resolved_reason")?,
        carried_from_run_id: row.try_get("carried_from_run_id")?,
        created_at: row.try_get("created_at")?,
    })
}

/// Unresolved rows first (the single sort point the design mandates), then
/// severity danger→warn→info, then age.
pub async fn list_exceptions_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Option<ExceptionPage>, LifecycleError> {
    if run_head(tx, run_id, false).await?.is_none() {
        return Ok(None);
    }
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = offset.unwrap_or(0).max(0);
    let total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM payroll_run_exceptions WHERE run_id = $1")
            .bind(run_id)
            .fetch_one(tx.as_mut())
            .await?;
    let open: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM payroll_run_exceptions WHERE run_id = $1 AND status = 'OPEN'",
    )
    .bind(run_id)
    .fetch_one(tx.as_mut())
    .await?;
    let rows = sqlx::query(
        "SELECT id, run_id, line_id, employee_id, employee_display_name, kind, severity, \
                amount_delta_won, summary_ko, detail, linked_refs, status, resolved_by, \
                resolved_at, resolved_reason, carried_from_run_id, created_at \
         FROM payroll_run_exceptions WHERE run_id = $1 \
         ORDER BY (status <> 'OPEN'), \
                  CASE severity WHEN 'danger' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, \
                  created_at, id \
         LIMIT $2 OFFSET $3",
    )
    .bind(run_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(tx.as_mut())
    .await?;
    let items = rows
        .iter()
        .map(exception_from_row)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(ExceptionPage {
        items,
        total,
        open,
        limit,
        offset,
    }))
}

pub async fn resolve_exception_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
    exception_id: Uuid,
    actor: Uuid,
    action: &str,
    reason: Option<&str>,
) -> Result<PayrollException, LifecycleError> {
    let Some(run) = run_head(tx, run_id, true).await? else {
        return Err(LifecycleError::NotFound);
    };
    if run.status != "CALCULATED" {
        return Err(invalid_state("resolve exceptions for", &run.status));
    }
    let new_status = match action {
        "CONFIRM" => "CONFIRMED",
        "HOLD" => {
            if reason.is_none_or(|r| r.trim().is_empty()) {
                return Err(LifecycleError::Validation(
                    "a reason is required to hold an exception to the next run".to_owned(),
                ));
            }
            "HELD"
        }
        other => {
            return Err(LifecycleError::Validation(format!(
                "unknown resolve action: {other}"
            )));
        }
    };
    let current: Option<String> = sqlx::query_scalar(
        "SELECT status FROM payroll_run_exceptions WHERE id = $1 AND run_id = $2 FOR UPDATE",
    )
    .bind(exception_id)
    .bind(run_id)
    .fetch_optional(tx.as_mut())
    .await?;
    match current.as_deref() {
        None => return Err(LifecycleError::NotFound),
        Some("OPEN") => {}
        Some(_) => return Err(LifecycleError::AlreadyResolved),
    }
    let row = sqlx::query(
        "UPDATE payroll_run_exceptions \
         SET status = $3, resolved_by = $4, resolved_at = now(), resolved_reason = $5, \
             updated_at = now() \
         WHERE id = $1 AND run_id = $2 \
         RETURNING id, run_id, line_id, employee_id, employee_display_name, kind, severity, \
                   amount_delta_won, summary_ko, detail, linked_refs, status, resolved_by, \
                   resolved_at, resolved_reason, carried_from_run_id, created_at",
    )
    .bind(exception_id)
    .bind(run_id)
    .bind(new_status)
    .bind(actor)
    .bind(reason)
    .fetch_one(tx.as_mut())
    .await?;
    exception_from_row(&row)
}

pub async fn exception_counts_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
) -> Result<(i64, i64), LifecycleError> {
    let row = sqlx::query(
        "SELECT COUNT(*)::BIGINT AS total, \
                COUNT(*) FILTER (WHERE status = 'OPEN')::BIGINT AS open \
         FROM payroll_run_exceptions WHERE run_id = $1",
    )
    .bind(run_id)
    .fetch_one(tx.as_mut())
    .await?;
    Ok((row.try_get("open")?, row.try_get("total")?))
}

// ---------------------------------------------------------------------------
// Submission / SoD decision / withdrawal
// ---------------------------------------------------------------------------

#[path = "decisions.rs"]
mod decisions;
pub use decisions::{decide_run_in_tx, submit_run_in_tx};

pub async fn withdraw_run_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
) -> Result<(), LifecycleError> {
    let Some(run) = run_head(tx, run_id, true).await? else {
        return Err(LifecycleError::NotFound);
    };
    if run.status != "REJECTED" {
        return Err(invalid_state("withdraw", &run.status));
    }
    // The rejection evidence lives in the audit trail; the columns reset so
    // the SoD CHECK admits a fresh submit/decide pair.
    sqlx::query(
        "UPDATE payroll_draft_runs \
         SET status = 'CALCULATED', submitted_by = NULL, submitted_at = NULL, \
             decided_by = NULL, decided_at = NULL, decision_reason = NULL, updated_at = now() \
         WHERE id = $1",
    )
    .bind(run_id)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Disbursement (operator-attested; no bank API exists)
// ---------------------------------------------------------------------------

fn disbursement_from_row(row: &sqlx::postgres::PgRow) -> Result<Disbursement, LifecycleError> {
    Ok(Disbursement {
        id: row.try_get("id")?,
        run_id: row.try_get("run_id")?,
        scheduled_at: row.try_get("scheduled_at")?,
        status: row.try_get("status")?,
        attested_by: row.try_get("attested_by")?,
        attested_at: row.try_get("attested_at")?,
        reason: row.try_get("reason")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

pub async fn get_disbursement_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
) -> Result<Option<Disbursement>, LifecycleError> {
    let row = sqlx::query(
        "SELECT id, run_id, scheduled_at, status, attested_by, attested_at, reason, \
                created_at, updated_at \
         FROM payroll_disbursements WHERE run_id = $1",
    )
    .bind(run_id)
    .fetch_optional(tx.as_mut())
    .await?;
    row.as_ref().map(disbursement_from_row).transpose()
}

pub async fn schedule_disbursement_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
    scheduled_at: OffsetDateTime,
) -> Result<Disbursement, LifecycleError> {
    let Some(run) = run_head(tx, run_id, true).await? else {
        return Err(LifecycleError::NotFound);
    };
    if run.status != "APPROVED" {
        return Err(invalid_state("schedule disbursement for", &run.status));
    }
    let row = sqlx::query(
        "INSERT INTO payroll_disbursements (org_id, run_id, scheduled_at) \
         SELECT r.org_id, r.id, $2 FROM payroll_draft_runs r WHERE r.id = $1 \
         ON CONFLICT (run_id) DO NOTHING \
         RETURNING id, run_id, scheduled_at, status, attested_by, attested_at, reason, \
                   created_at, updated_at",
    )
    .bind(run_id)
    .bind(scheduled_at)
    .fetch_optional(tx.as_mut())
    .await?;
    let Some(row) = row else {
        return Err(LifecycleError::InvalidState(
            "a disbursement is already scheduled for this run".to_owned(),
        ));
    };
    sqlx::query(
        "UPDATE payroll_draft_runs SET status = 'DISBURSEMENT_SCHEDULED', updated_at = now() \
         WHERE id = $1",
    )
    .bind(run_id)
    .execute(tx.as_mut())
    .await?;
    disbursement_from_row(&row)
}

pub async fn attest_disbursement_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
    actor: Uuid,
    new_status: &str,
    reason: Option<&str>,
) -> Result<Disbursement, LifecycleError> {
    let Some(run) = run_head(tx, run_id, true).await? else {
        return Err(LifecycleError::NotFound);
    };
    let row = sqlx::query(
        "SELECT id, run_id, scheduled_at, status, attested_by, attested_at, reason, \
                created_at, updated_at \
         FROM payroll_disbursements WHERE run_id = $1 FOR UPDATE",
    )
    .bind(run_id)
    .fetch_optional(tx.as_mut())
    .await?;
    let Some(row) = row else {
        return Err(LifecycleError::InvalidState(
            "no disbursement is scheduled for this run".to_owned(),
        ));
    };
    let current = disbursement_from_row(&row)?;
    let allowed = matches!(
        (current.status.as_str(), new_status),
        ("SCHEDULED", "SUBMITTED_TO_BANK")
            | ("SUBMITTED_TO_BANK", "PAID")
            | ("SUBMITTED_TO_BANK", "FAILED")
            | ("FAILED", "SCHEDULED")
    );
    if !allowed {
        return Err(LifecycleError::InvalidTransition(format!(
            "cannot attest {new_status} from {}",
            current.status
        )));
    }
    if new_status == "FAILED" && reason.is_none_or(|r| r.trim().is_empty()) {
        return Err(LifecycleError::Validation(
            "a reason is required to attest a failed disbursement".to_owned(),
        ));
    }
    let row = sqlx::query(
        "UPDATE payroll_disbursements \
         SET status = $2, attested_by = $3, attested_at = now(), \
             reason = CASE WHEN $2 = 'FAILED' THEN $4 ELSE NULL END, updated_at = now() \
         WHERE run_id = $1 \
         RETURNING id, run_id, scheduled_at, status, attested_by, attested_at, reason, \
                   created_at, updated_at",
    )
    .bind(run_id)
    .bind(new_status)
    .bind(actor)
    .bind(reason)
    .fetch_one(tx.as_mut())
    .await?;
    if new_status == "PAID" {
        if run.status != "DISBURSEMENT_SCHEDULED" {
            return Err(invalid_state("mark paid", &run.status));
        }
        sqlx::query(
            "UPDATE payroll_draft_runs SET status = 'PAID', updated_at = now() WHERE id = $1",
        )
        .bind(run_id)
        .execute(tx.as_mut())
        .await?;
    }
    disbursement_from_row(&row)
}

// ---------------------------------------------------------------------------
// Payslip issuance (release-gated) + delivery readback
// ---------------------------------------------------------------------------

/// Parse the release-gate record registered at
/// `payroll_draft_runs.legal_basis.release_gate` and validate it with the
/// domain kernel. An absent or invalid record is a [`LifecycleError::LegalGate`].
pub fn validate_run_release_gate(legal_basis: &Value) -> Result<(), LifecycleError> {
    let Some(gate) = legal_basis.get("release_gate") else {
        return Err(LifecycleError::LegalGate(
            "no release-gate record is registered for this run (노무사/세무사 검증 필요)"
                .to_owned(),
        ));
    };
    let input = parse_release_gate(gate)?;
    validate_release_gate(&input).map_err(|err| LifecycleError::LegalGate(err.message))
}

fn gate_str(gate: &Value, key: &str) -> Result<String, LifecycleError> {
    gate.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| LifecycleError::LegalGate(format!("release-gate record is missing {key}")))
}

/// The i64 twin of [`gate_str`]. `Value::as_i64` is `None` for a JSON float and
/// for a numeric string, so this refuses `373300.0` and `"373300"` — not merely
/// an absent key. A key-presence check would leave that hole open.
fn gate_i64(gate: &Value, key: &str) -> Result<i64, LifecycleError> {
    gate.get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| LifecycleError::LegalGate(format!("release-gate record is missing {key}")))
}

fn gate_bool(gate: &Value, key: &str) -> Result<bool, LifecycleError> {
    gate.get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| LifecycleError::LegalGate(format!("release-gate record is missing {key}")))
}

fn parse_release_gate(gate: &Value) -> Result<PayrollReleaseGateInput, LifecycleError> {
    let rate_table_version = gate_str(gate, "rate_table_version")?;
    // ARGUED, not done quietly: this was `.filter_map(Value::as_str)`, the last
    // silent coercion left in this parser. A mixed list SHRANK instead of
    // failing — `["https://…", 12345]` parsed as one source, so a record that
    // declared two official sources satisfied the domain's "at least one" check
    // while the second silently did not exist. Strictly stricter: a non-string
    // entry is now refused by name, and nothing that used to be refused is now
    // accepted.
    let official_source_urls = gate
        .get("official_source_urls")
        .and_then(Value::as_array)
        .map(|urls| {
            urls.iter()
                .map(|url| {
                    url.as_str().map(str::to_owned).ok_or_else(|| {
                        LifecycleError::LegalGate(
                            "release-gate record has a non-string official_source_urls entry"
                                .to_owned(),
                        )
                    })
                })
                .collect::<Result<Vec<_>, LifecycleError>>()
        })
        .transpose()?
        .unwrap_or_default();
    let golden_cases = gate
        .get("golden_cases")
        .and_then(Value::as_array)
        .map(|cases| {
            cases
                .iter()
                .map(|case| {
                    let tax = case.get("nts_tax_row").ok_or_else(|| {
                        LifecycleError::LegalGate(
                            "release-gate record is missing nts_tax_row".to_owned(),
                        )
                    })?;
                    // The one OPTIONAL kernel input, because the kernel itself
                    // treats it as optional: absent means "use the gross".
                    // Present-but-wrong-typed is still refused.
                    let pension_key = "pension_standard_monthly_income_won";
                    let pension_standard_monthly_income_won = match case.get(pension_key) {
                        None | Some(Value::Null) => None,
                        Some(_) => Some(gate_i64(case, pension_key)?),
                    };
                    Ok(GoldenPayrollCase {
                        case_id: gate_str(case, "case_id")?,
                        rate_table_version: gate_str(case, "rate_table_version")?,
                        // ARGUED, not done quietly: this was `.unwrap_or(false)`.
                        // Leaving one silent default beside the one being deleted
                        // below is the exact defect this change exists to kill — a
                        // typo'd key became a silent `false` that then failed
                        // downstream for the WRONG reason. Strictly stricter: a
                        // record that used to be accepted-then-refused is now
                        // refused by name, and none that used to be refused is
                        // now accepted.
                        professionally_validated: gate_bool(case, "professionally_validated")?,
                        // The stored case now carries the facts needed to
                        // RE-EXECUTE it. Every field is required: a case that
                        // cannot be recomputed must never read as satisfied.
                        inputs: LineCalculationInput {
                            pay_date: Date::parse(&gate_str(case, "pay_date")?, &Iso8601::DEFAULT)
                                .map_err(|err| {
                                    LifecycleError::LegalGate(format!(
                                        "invalid golden case pay_date: {err}"
                                    ))
                                })?,
                            gross_won: gate_i64(case, "monthly_gross_pay_won")?,
                            pension_standard_monthly_income_won,
                            tax_row: VerifiedNtsTaxRow {
                                table_version: gate_str(tax, "table_version")?,
                                monthly_income_tax_won: gate_i64(tax, "monthly_income_tax_won")?,
                                local_income_tax_won: gate_i64(tax, "local_income_tax_won")?,
                            },
                        },
                        // THE SILENT ZERO. Was `.unwrap_or(0)` — a stored case
                        // with no expectation read as "expects 0" and, before
                        // this slice, nothing ever compared it to anything.
                        expected_total_employee_deductions_won: gate_i64(
                            case,
                            "expected_total_employee_deductions_won",
                        )?,
                    })
                })
                .collect::<Result<Vec<_>, LifecycleError>>()
        })
        .transpose()?
        .unwrap_or_default();
    let professional_validation = gate
        .get("professional_validation")
        .map(|validation| {
            let reviewer_kind = match gate_str(validation, "reviewer_kind")?.as_str() {
                "labor_attorney" => ProfessionalReviewerKind::LaborAttorney,
                "tax_accountant" => ProfessionalReviewerKind::TaxAccountant,
                other => {
                    return Err(LifecycleError::LegalGate(format!(
                        "unknown professional reviewer kind: {other}"
                    )));
                }
            };
            let reviewed_on = Date::parse(&gate_str(validation, "reviewed_on")?, &Iso8601::DEFAULT)
                .map_err(|err| {
                    LifecycleError::LegalGate(format!("invalid reviewed_on date: {err}"))
                })?;
            Ok(ProfessionalValidation {
                reviewer_kind,
                reviewed_on,
                artifact_sha256: gate_str(validation, "artifact_sha256")?,
                reviewer_reference: gate_str(validation, "reviewer_reference")?,
            })
        })
        .transpose()?;
    Ok(PayrollReleaseGateInput {
        rate_table_version,
        official_source_urls,
        golden_cases,
        professional_validation,
    })
}

/// Record the delivered inbox docs and flip the run to ISSUED. Idempotent:
/// links insert `ON CONFLICT DO NOTHING`, so an interrupted issuance can be
/// re-driven to completion.
pub async fn record_payslip_deliveries_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
    deliveries: &[(Uuid, Uuid, Uuid)],
) -> Result<(), LifecycleError> {
    let Some(run) = run_head(tx, run_id, true).await? else {
        return Err(LifecycleError::NotFound);
    };
    if run.status != "PAID" {
        return Err(invalid_state("record payslip deliveries for", &run.status));
    }
    for (line_id, employee_id, inbox_doc_id) in deliveries {
        sqlx::query(
            "INSERT INTO payroll_payslip_deliveries \
             (org_id, run_id, line_id, employee_id, inbox_doc_id) \
             SELECT r.org_id, r.id, $2, $3, $4 FROM payroll_draft_runs r WHERE r.id = $1 \
             ON CONFLICT (org_id, run_id, line_id) DO NOTHING",
        )
        .bind(run_id)
        .bind(line_id)
        .bind(employee_id)
        .bind(inbox_doc_id)
        .execute(tx.as_mut())
        .await?;
    }
    sqlx::query(
        "UPDATE payroll_draft_runs SET status = 'ISSUED', updated_at = now() WHERE id = $1",
    )
    .bind(run_id)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

pub async fn payslip_delivery_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Option<PayslipDeliverySummary>, LifecycleError> {
    if run_head(tx, run_id, false).await?.is_none() {
        return Ok(None);
    }
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = offset.unwrap_or(0).max(0);
    let counts = sqlx::query(
        "SELECT COUNT(*)::BIGINT AS issued, \
                COUNT(i.confirmed_at)::BIGINT AS acknowledged \
         FROM payroll_payslip_deliveries d \
         LEFT JOIN inbox_docs i ON i.id = d.inbox_doc_id \
         WHERE d.run_id = $1",
    )
    .bind(run_id)
    .fetch_one(tx.as_mut())
    .await?;
    let issued: i64 = counts.try_get("issued")?;
    let acknowledged: i64 = counts.try_get("acknowledged")?;
    let rows = sqlx::query(
        "SELECT d.line_id, d.employee_id, d.inbox_doc_id, d.issued_at, i.confirmed_at \
         FROM payroll_payslip_deliveries d \
         LEFT JOIN inbox_docs i ON i.id = d.inbox_doc_id \
         WHERE d.run_id = $1 \
         ORDER BY d.issued_at, d.line_id \
         LIMIT $2 OFFSET $3",
    )
    .bind(run_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(tx.as_mut())
    .await?;
    let items = rows
        .iter()
        .map(|row| {
            Ok(PayslipDeliveryItem {
                line_id: row.try_get("line_id")?,
                employee_id: row.try_get("employee_id")?,
                inbox_doc_id: row.try_get("inbox_doc_id")?,
                issued_at: row.try_get("issued_at")?,
                acknowledged_at: row.try_get("confirmed_at")?,
            })
        })
        .collect::<Result<Vec<_>, LifecycleError>>()?;
    Ok(Some(PayslipDeliverySummary {
        run_id,
        issued,
        acknowledged,
        items,
        total: issued,
        limit,
        offset,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use console_kernel_core::ErrorKind;
    use console_platform_db::DbError;

    /// Hostile pin: store-path `From<LifecycleError> for PgPayrollError` must
    /// preserve kinds (0a7z residual). Flattening non-NotFound arms to
    /// `Internal` is the failure this lane closes.
    fn assert_pg_kind(err: LifecycleError, expected: ErrorKind) {
        assert_eq!(crate::PgPayrollError::from(err).kind(), expected);
    }

    #[test]
    fn lifecycle_into_pg_payroll_error_preserves_kernel_kinds() {
        assert_pg_kind(LifecycleError::NotFound, ErrorKind::NotFound);
        assert_pg_kind(
            LifecycleError::Validation("bad input".into()),
            ErrorKind::Validation,
        );
        assert_pg_kind(
            LifecycleError::InvalidTransition("draft→paid".into()),
            ErrorKind::InvalidTransition,
        );
        assert_pg_kind(
            LifecycleError::InvalidState("cannot decide a run in status OPEN".into()),
            ErrorKind::Conflict,
        );
        assert_pg_kind(
            LifecycleError::PreflightBlocked(ClosePreflight {
                checks: Vec::new(),
                can_close: false,
            }),
            ErrorKind::Conflict,
        );
        assert_pg_kind(LifecycleError::ExceptionsOpen(3), ErrorKind::Conflict);
        assert_pg_kind(LifecycleError::SodViolation, ErrorKind::Conflict);
        assert_pg_kind(LifecycleError::AlreadyResolved, ErrorKind::Conflict);
        assert_pg_kind(
            LifecycleError::LegalGate("missing reviewed_on".into()),
            ErrorKind::Conflict,
        );
        assert_pg_kind(
            LifecycleError::Db(DbError::Sqlx(sqlx::Error::RowNotFound)),
            ErrorKind::NotFound,
        );
    }

    fn payroll_row(gross: i64, income_tax: i64) -> Value {
        json!({
            "payroll": {
                "monthly_gross_pay_won": gross,
                "nts_tax_row": {
                    "table_version": "v1",
                    "monthly_income_tax_won": income_tax,
                    "local_income_tax_won": income_tax / 10,
                },
            },
        })
    }

    #[test]
    fn source_amount_selection_is_deterministic_and_fail_closed() {
        // No payroll-bearing row → truthful blocker.
        assert_eq!(
            select_source_amounts(&[]).err(),
            Some("SOURCE_AMOUNTS_NOT_MATERIALIZED")
        );
        assert_eq!(
            select_source_amounts(&[json!({"attendance": {}})]).err(),
            Some("SOURCE_AMOUNTS_NOT_MATERIALIZED")
        );

        // Byte-identical duplicates (re-import of the same source) are fine.
        let selected = select_source_amounts(&[
            json!({"attendance": {}}),
            payroll_row(3_000_000, 74_350),
            payroll_row(3_000_000, 74_350),
        ])
        .unwrap();
        assert_eq!(selected.gross_won, 3_000_000);
        assert_eq!(selected.tax_row.monthly_income_tax_won, 74_350);

        // Two DIFFERENT figure sets → ambiguity is a blocker, never a pick.
        assert_eq!(
            select_source_amounts(&[
                payroll_row(3_000_000, 74_350),
                payroll_row(3_100_000, 74_350)
            ])
            .err(),
            Some("SOURCE_AMOUNTS_CONFLICTING")
        );
    }

    /// The release-gate record shape written by the REST fixture
    /// (`payroll/rest/tests/run_lifecycle_api.rs`), hand-copied key for key.
    /// That file needs PostgreSQL 17 and runs in no workflow, so a key typo or
    /// a bad date form in it has no execution proof of its own — this copy is
    /// the only thing that catches one.
    fn release_gate_record() -> Value {
        json!({
            "release_gate": {
                "rate_table_version": "statutory-rates-2026-06-27",
                "official_source_urls": [
                    "https://www.nps.or.kr/pnsinfo/ntpsklg/getOHAF0038M0.do",
                ],
                "golden_cases": [{
                    "case_id": "GC-2026-06-A",
                    "rate_table_version": "statutory-rates-2026-06-27",
                    "professionally_validated": true,
                    "pay_date": "2026-06-30",
                    "monthly_gross_pay_won": 3_000_000,
                    "nts_tax_row": {
                        "table_version": "NTS-간이세액표-fixture-row-v1",
                        "monthly_income_tax_won": 74_350,
                        "local_income_tax_won": 7_430,
                    },
                    "expected_total_employee_deductions_won": 373_300,
                }],
                "professional_validation": {
                    "reviewer_kind": "labor_attorney",
                    "reviewed_on": "2026-07-01",
                    "artifact_sha256":
                        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                    "reviewer_reference": "노무법인 검증 2026-07",
                },
            },
        })
    }

    /// `Value` indexes into a nested object but cannot delete through the
    /// index, so every removal below needs this same `as_object_mut` step.
    fn remove_key(object: &mut Value, key: &str) {
        object
            .as_object_mut()
            .expect("a JSON object to remove a key from")
            .remove(key);
    }

    fn without_golden_case_key(key: &str) -> Value {
        let mut record = release_gate_record();
        remove_key(&mut record["release_gate"]["golden_cases"][0], key);
        record
    }

    fn with_golden_case_key(key: &str, value: Value) -> Value {
        let mut record = release_gate_record();
        record["release_gate"]["golden_cases"][0][key] = value;
        record
    }

    fn gate_refusal(record: &Value) -> String {
        validate_run_release_gate(record)
            .expect_err("this release-gate record must be refused")
            .to_string()
    }

    #[test]
    fn release_gate_record_whose_golden_case_omits_calculation_inputs_is_refused() {
        // A case that cannot be recomputed must never read as satisfied. Each
        // key is pinned to its own refusal message, which is strictly stronger
        // than "some error": a silent zero relocated into a different failure
        // (or into the arithmetic comparison) fails this assertion too.
        for key in [
            "monthly_gross_pay_won",
            "pay_date",
            "nts_tax_row",
            "expected_total_employee_deductions_won",
            "professionally_validated",
        ] {
            assert_eq!(
                gate_refusal(&without_golden_case_key(key)),
                format!(
                    "payslip release gate is not satisfied: \
                     release-gate record is missing {key}"
                ),
                "a stored golden case with no {key} must be REFUSED, not defaulted"
            );
        }
    }

    #[test]
    fn release_gate_record_copied_from_the_rest_fixture_parses_and_has_its_expected_total_compared()
    {
        validate_run_release_gate(&release_gate_record()).unwrap();

        let mut off_by_one = release_gate_record();
        off_by_one["release_gate"]["golden_cases"][0]["expected_total_employee_deductions_won"] =
            json!(373_303);

        assert_eq!(
            gate_refusal(&off_by_one),
            "payslip release gate is not satisfied: golden case GC-2026-06-A \
             expects total employee deductions 373303 \
             but the payroll kernel computed 373300"
        );
    }

    #[test]
    fn release_gate_record_whose_golden_case_amounts_are_not_json_integers_is_refused() {
        // `Value::as_i64` / `as_bool` ARE the whole type check, and line
        // coverage cannot see this: an absent key and a wrong-typed one leave
        // through the same `ok_or_else`, so the omission test above keeps these
        // lines green either way. Only this test stands between the signed
        // money figures and a "helpful" `as_f64()` fallback that would truncate
        // 373300.9 into a passing gate, or a truthy-string fallback that would
        // turn `"professionally_validated": "no"` into a sign-off.
        for (key, wrong_type) in [
            ("monthly_gross_pay_won", json!(3_000_000.0)),
            ("monthly_gross_pay_won", json!("3000000")),
            ("expected_total_employee_deductions_won", json!(373_300.0)),
            ("expected_total_employee_deductions_won", json!("373300")),
            ("professionally_validated", json!("true")),
            ("professionally_validated", json!(1)),
        ] {
            assert_eq!(
                gate_refusal(&with_golden_case_key(key, wrong_type.clone())),
                format!(
                    "payslip release gate is not satisfied: \
                     release-gate record is missing {key}"
                ),
                "{wrong_type} is not an acceptable {key} and must be REFUSED, not coerced"
            );
        }
    }

    #[test]
    fn release_gate_record_whose_nts_tax_row_omits_a_field_is_refused() {
        // The simplified withholding tax table row is the professionally
        // verified half of the case. A zero-defaulted earned income tax would
        // understate the recomputed total by exactly the tax and still be
        // compared against something, so the refusal has to happen at the
        // parse, not at the arithmetic.
        for key in [
            "table_version",
            "monthly_income_tax_won",
            "local_income_tax_won",
        ] {
            let mut record = release_gate_record();
            remove_key(
                &mut record["release_gate"]["golden_cases"][0]["nts_tax_row"],
                key,
            );

            assert_eq!(
                gate_refusal(&record),
                format!(
                    "payslip release gate is not satisfied: \
                     release-gate record is missing {key}"
                ),
                "an NTS tax row with no {key} must be REFUSED, not defaulted"
            );
        }
    }

    #[test]
    fn release_gate_record_whose_golden_case_pay_date_is_unparseable_is_refused() {
        // The only branch in the parser with its own error text, and the only
        // required input whose refusal is not a missing key. A fallback date
        // here would silently move the case into a different effective-rate
        // window and recompute a figure nobody signed.
        for bad in ["2026-06-31", "30/06/2026", "2026-06", ""] {
            let message = gate_refusal(&with_golden_case_key("pay_date", json!(bad)));
            assert!(
                message.starts_with(
                    "payslip release gate is not satisfied: invalid golden case pay_date: "
                ),
                "expected a pay_date parse refusal for {bad:?}, got: {message}"
            );
        }
    }

    #[test]
    fn release_gate_record_carries_a_declared_pension_standard_monthly_income_into_the_kernel() {
        // The one OPTIONAL kernel input, and the only one that moves a figure
        // without moving the gross. 2,000,000 is inside the 2026-06 National
        // Pension base window (400,000..6,370,000) so the clamp does not erase
        // it: the pension line drops by 47,500 and the total lands on 325,802.
        // A parser that dropped the key would recompute 373,302 here.
        let mut declared =
            with_golden_case_key("pension_standard_monthly_income_won", json!(2_000_000));
        declared["release_gate"]["golden_cases"][0]["expected_total_employee_deductions_won"] =
            json!(325_800);
        validate_run_release_gate(&declared).unwrap();

        // An explicit JSON null is the ABSENT case — the kernel falls back to
        // the gross, so the record's own 373,302 still holds.
        validate_run_release_gate(&with_golden_case_key(
            "pension_standard_monthly_income_won",
            json!(null),
        ))
        .unwrap();

        // Present but not an integer is REFUSED, never quietly ignored:
        // ignoring it recomputes on a basis the reviewer did not sign.
        assert_eq!(
            gate_refusal(&with_golden_case_key(
                "pension_standard_monthly_income_won",
                json!("2000000")
            )),
            "payslip release gate is not satisfied: \
             release-gate record is missing pension_standard_monthly_income_won"
        );
    }

    #[test]
    fn release_gate_record_with_no_parseable_golden_case_list_is_refused() {
        // `golden_cases` itself is still `.unwrap_or_default()`-ed, so an
        // absent, empty, null or non-array list parses as ZERO cases and the
        // recomputation loop iterates over nothing. The domain's non-empty
        // check is the only thing that keeps that fail-closed rather than
        // "passed, having compared nothing" — this pins the composition, which
        // neither crate's own tests can see.
        for cases in [json!([]), json!(null), json!("GC-2026-06-A"), json!({})] {
            let mut record = release_gate_record();
            record["release_gate"]["golden_cases"] = cases.clone();

            assert_eq!(
                gate_refusal(&record),
                "payslip release gate is not satisfied: \
                 at least one payroll golden case is required",
                "a {cases} golden-case list must be REFUSED"
            );
        }

        let mut absent = release_gate_record();
        remove_key(&mut absent["release_gate"], "golden_cases");
        assert_eq!(
            gate_refusal(&absent),
            "payslip release gate is not satisfied: \
             at least one payroll golden case is required"
        );
    }

    #[test]
    fn release_gate_record_whose_official_source_url_list_holds_a_non_string_is_refused() {
        // The list SHRANK silently rather than failing, and the domain gate only
        // counts it — so a record naming two official sources satisfied "at
        // least one" while the second was never parsed at all. Not reachable
        // through an empty list: this needs a list that still has a survivor,
        // which is precisely why counting could not notice.
        let mut two_sources = release_gate_record();
        two_sources["release_gate"]["official_source_urls"] = json!([
            "https://www.nps.or.kr/pnsinfo/ntpsklg/getOHAF0038M0.do",
            12345,
        ]);

        assert_eq!(
            gate_refusal(&two_sources),
            "payslip release gate is not satisfied: \
             release-gate record has a non-string official_source_urls entry"
        );

        // ...and a list whose entries are all strings still parses, so this is
        // strictly a refusal of the malformed entry and not of the key.
        validate_run_release_gate(&release_gate_record()).unwrap();
    }

    #[test]
    fn release_gate_record_with_a_negative_stored_amount_is_refused_by_the_kernel() {
        // `gate_i64` accepts any i64, including a negative one, so the only
        // thing between a stored `-3000000` gross and a recomputed total is
        // `build_line_calculation`'s own guard — and llvm-cov reported that
        // guard (domain lib.rs:726-728) unexecuted. A negative gross now
        // reaches it through a stored record, so the composition is pinned
        // here rather than assumed.
        assert_eq!(
            gate_refusal(&with_golden_case_key(
                "monthly_gross_pay_won",
                json!(-3_000_000)
            )),
            "payslip release gate is not satisfied: golden case GC-2026-06-A \
             could not be recomputed: monthly remuneration must be non-negative"
        );
    }

    #[test]
    fn release_gate_record_pins_both_reviewer_kinds_and_refuses_any_third() {
        // The tax accountant is half of the "labor attorney/tax accountant"
        // this whole gate exists for and no test had ever constructed one:
        // llvm-cov reported the `tax_accountant` arm and the unknown-kind
        // refusal (lifecycle.rs:1254-1258) unexecuted. `reviewed_on`
        // (1261-1264) was unexercised for the same reason `pay_date` was.
        //
        // The mapping is asserted against `parse_release_gate` directly, NOT
        // through `validate_run_release_gate`: the gate never reads
        // `reviewer_kind`, so an arm that mapped tax accountant to
        // LaborAttorney would still validate. Going through the gate here would
        // have pinned only that the STRING is accepted, which is not what this
        // claims.
        let mut tax_accountant = release_gate_record();
        tax_accountant["release_gate"]["professional_validation"]["reviewer_kind"] =
            json!("tax_accountant");
        validate_run_release_gate(&tax_accountant).unwrap();
        assert_eq!(
            parse_release_gate(&tax_accountant["release_gate"])
                .unwrap()
                .professional_validation
                .unwrap()
                .reviewer_kind,
            ProfessionalReviewerKind::TaxAccountant
        );

        let mut third_kind = release_gate_record();
        third_kind["release_gate"]["professional_validation"]["reviewer_kind"] =
            json!("certified_public_accountant");
        assert_eq!(
            gate_refusal(&third_kind),
            "payslip release gate is not satisfied: \
             unknown professional reviewer kind: certified_public_accountant"
        );

        let mut bad_date = release_gate_record();
        bad_date["release_gate"]["professional_validation"]["reviewed_on"] = json!("2026-07-32");
        let message = gate_refusal(&bad_date);
        assert!(
            message
                .starts_with("payslip release gate is not satisfied: invalid reviewed_on date: "),
            "expected a reviewed_on parse refusal, got: {message}"
        );
    }

    #[test]
    fn a_run_with_no_release_gate_record_at_all_is_refused() {
        // The outermost fail-closed, and it had no test: everything above
        // assumes a `release_gate` key exists. An unregistered gate must be a
        // refusal, never an empty-but-satisfied one.
        assert_eq!(
            gate_refusal(&json!({"other_basis": {"note": "무관한 근거"}})),
            "payslip release gate is not satisfied: no release-gate record is \
             registered for this run (노무사/세무사 검증 필요)"
        );
    }
}
