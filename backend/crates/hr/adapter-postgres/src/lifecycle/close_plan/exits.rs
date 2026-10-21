//! A close plan's 퇴직 lines: each opens an exit case (as the exit report
//! does, in the plan's transaction) with 마지막 근무일 = the day before the
//! 폐쇄일 and its BW-07 `exit_reason` (CLOSURE 폐업 · INSOLVENCY 도산), or
//! joins the person's open case. The case then goes the usual way (HR
//! confirmation records the TERMINATE); the close waits for it.

use console_kernel_core::{AuditAction, AuditEvent, BranchId, OrgId, TraceContext, UserId};
use console_settings_domain::code_lists::ReasonDomain;
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use time::{Date, OffsetDateTime};
use uuid::Uuid;

use crate::HrError;
use crate::exits::store::resolve_exit_case_branch;
use crate::lifecycle::title_reason::validate_reason_code;

/// The 퇴직 사유 a close may give: 폐업 (default) or 도산.
pub(crate) const CLOSE_EXIT_REASONS: [&str; 2] = ["CLOSURE", "INSOLVENCY"];

/// The note every case a close opens carries.
const NOTE: &str = "사업장 폐쇄";

/// The person's open exit case, if any (`REJECTED`/`CANCELLED`/`SUBMITTED`
/// are closed), with its status and date.
pub(crate) async fn open_case(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee: Uuid,
) -> Result<Option<(Uuid, String, String)>, HrError> {
    Ok(sqlx::query_as(
        "SELECT id, status, effective_exit_date::TEXT FROM employee_exit_cases \
         WHERE org_id = $1 AND employee_id = $2 AND status NOT IN ('REJECTED','CANCELLED','SUBMITTED')",
    )
    .bind(org)
    .bind(employee)
    .fetch_optional(tx.as_mut())
    .await?)
}

/// Validate a line's reason (or refuse it, as `Value` naming the person).
pub(crate) async fn checked_reason(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    employee: Uuid,
    code: Option<&str>,
) -> Result<Result<String, Value>, HrError> {
    let code = code.map_or("CLOSURE", str::trim);
    if !CLOSE_EXIT_REASONS.contains(&code) {
        return Ok(Err(
            json!({ "employee_id": employee, "code": "exit_reason_not_for_close",
            "message": "a close gives 퇴직 사유 CLOSURE (폐업) or INSOLVENCY (도산)" }),
        ));
    }
    match validate_reason_code(tx, org, ReasonDomain::ExitReason, code, Some(NOTE)).await {
        Ok(_) => Ok(Ok(code.to_owned())),
        Err(e) if e.status.is_client_error() => Ok(Err(
            json!({ "employee_id": employee, "code": e.code, "message": e.message }),
        )),
        Err(e) => Err(e),
    }
}

/// Open (or join) the exit case of `employee` for a close on `closed_on`.
/// `Ok(Err(refusal))` when the person cannot leave that day (already
/// EXITED, a 퇴직일 before the 입사일, an exit already scheduled).
pub(crate) async fn open_for_close(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    employee: Uuid,
    closed_on: Date,
    reason: &str,
) -> Result<Result<(Uuid, Option<AuditEvent>), Value>, HrError> {
    let org_uuid = *org.as_uuid();
    if let Some((case, _, _)) = open_case(tx, org_uuid, employee).await? {
        return Ok(Ok((case, None)));
    }
    let last_day = closed_on
        .previous_day()
        .ok_or_else(|| HrError::validation("closed_on is out of range"))?;
    let refuse = |code: &str, message: &str| {
        Ok(Err(
            json!({ "employee_id": employee, "code": code, "message": message }),
        ))
    };
    let (hire, scheduled): (Option<Date>, bool) = sqlx::query_as(
        "SELECT e.hire_on, EXISTS (SELECT 1 FROM employee_lifecycle_events l WHERE l.org_id = e.org_id \
           AND l.employee_id = e.id AND l.event_type = 'TERMINATE' AND l.state = 'SCHEDULED') \
         FROM employees e WHERE e.org_id = $1 AND e.id = $2",
    )
    .bind(org_uuid)
    .bind(employee)
    .fetch_one(tx.as_mut())
    .await?;
    if hire.is_some_and(|h| last_day < h) {
        return refuse(
            "effective_date_before_hire",
            "the 마지막 근무일 (the day before the 폐쇄일) is before the 입사일",
        );
    }
    if scheduled {
        return refuse(
            "exit_already_scheduled",
            "the employee already has a scheduled exit",
        );
    }
    let branch = resolve_exit_case_branch(tx, org_uuid, employee, None, None).await?;
    let case: Uuid = sqlx::query_scalar(
        "INSERT INTO employee_exit_cases (org_id, employee_id, branch_id, effective_exit_date, site_manager_note, \
           reported_by, exit_reason_code) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
    )
    .bind(org_uuid)
    .bind(employee)
    .bind(branch)
    .bind(last_day)
    .bind(NOTE)
    .bind(*actor.as_uuid())
    .bind(reason)
    .fetch_one(tx.as_mut())
    .await?;
    let mut event = AuditEvent::new(
        Some(actor),
        AuditAction::new("employee.exit.report").map_err(HrError::from_kernel)?,
        "employee",
        employee.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(
        None,
        Some(json!({
            "employee_id": employee, "effective_exit_date": last_day.to_string(),
            "exit_reason_code": reason, "branch_id": branch, "opened_by": "workplace.close_plan",
        })),
    );
    if let Some(branch) = branch {
        event = event.with_branch(BranchId::from_uuid(branch));
    }
    Ok(Ok((case, Some(event))))
}
