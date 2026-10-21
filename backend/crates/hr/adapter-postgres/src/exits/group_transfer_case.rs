//! The sending 법인's settlement case of a 전적 (decisions #30;
//! design/inter-entity-transfer.md §3.3, the A-side trail): the 전적 is the
//! 퇴직 at the sending 법인, so its exit case opens with it, in its
//! transaction, already past the HR confirmation (the 전적 itself is the
//! recorded exit; no TERMINATE). The case carries the 전적 event as its exit
//! event, 마지막 근무일 = the day before the start, 퇴직 사유 `GROUP_TRANSFER`,
//! and then goes the usual way: HQ confirmation, 퇴직금 · 금품청산 settlement,
//! approval. Access is not ended (the person stays employed in the tenant).
//!
//! The way back is the 전적's own: withdrawing a scheduled 전적, replacing it,
//! or rescinding it cancels the case here; the case's reject and cancel
//! refuse (`exit_case_follows_group_transfer`).

use console_kernel_core::{AuditAction, AuditEvent, BranchId, OrgId, TraceContext, UserId};
use http::StatusCode;
use serde_json::json;
use sqlx::{Postgres, Transaction};
use time::{Date, OffsetDateTime};
use uuid::Uuid;

use crate::HrError;
use crate::exits::report::exit_case_open;
use crate::exits::settlement_store::upsert_exit_settlement_package;
use crate::exits::store::resolve_exit_case_branch;

/// The 퇴직 사유 a 전적's case carries (catalog `reason.exit_reason.GROUP_TRANSFER`).
pub const GROUP_TRANSFER_EXIT_REASON: &str = "GROUP_TRANSFER";

fn event(
    actor: UserId,
    org: OrgId,
    action: &str,
    case: Uuid,
    branch: Option<Uuid>,
    after: serde_json::Value,
) -> Result<AuditEvent, HrError> {
    let mut e = AuditEvent::new(
        Some(actor),
        AuditAction::new(action).map_err(HrError::from_kernel)?,
        "employee_exit_case",
        case.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(None, Some(after));
    if let Some(branch) = branch {
        e = e.with_branch(BranchId::from_uuid(branch));
    }
    Ok(e)
}

/// The branch the case belongs to: the person's at the sending 법인, read
/// before the 전적 moves them.
///
/// # Errors
/// A database fault.
pub async fn sending_branch(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee: Uuid,
) -> Result<Option<Uuid>, HrError> {
    resolve_exit_case_branch(tx, org, employee, None, None).await
}

/// Opens the settlement case of the 전적 `event` starting `start`.
///
/// # Errors
/// 409 `exit_case_open` naming the person's open exit case (one at a time;
/// nothing is written, the caller rolls back), or a database fault.
pub async fn open_settlement_case(
    tx: &mut Transaction<'_, Postgres>,
    (org, actor): (OrgId, UserId),
    (employee, event_id, branch): (Uuid, Uuid, Option<Uuid>),
    start: Date,
    note: &str,
) -> Result<(Uuid, AuditEvent), HrError> {
    let org_uuid = *org.as_uuid();
    let last_day = start
        .previous_day()
        .ok_or_else(|| HrError::validation("effective_date is out of range"))?;
    let case: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO employee_exit_cases (org_id, employee_id, branch_id, effective_exit_date, site_manager_note, \
           reported_by, exit_reason_code, status, hr_confirmed_by, hr_confirmed_at, exit_lifecycle_event_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'HR_CONFIRMED', $6, now(), $8) \
         ON CONFLICT (org_id, employee_id) WHERE status NOT IN ('REJECTED','CANCELLED','SUBMITTED') DO NOTHING \
         RETURNING id",
    )
    .bind(org_uuid)
    .bind(employee)
    .bind(branch)
    .bind(last_day)
    .bind(note)
    .bind(*actor.as_uuid())
    .bind(GROUP_TRANSFER_EXIT_REASON)
    .bind(event_id)
    .fetch_optional(tx.as_mut())
    .await?;
    let Some(case) = case else {
        return Err(exit_case_open(tx, org_uuid, employee).await?);
    };
    upsert_exit_settlement_package(tx, org_uuid, case, None).await?;
    let audit = event(
        actor,
        org,
        "employee.exit.report",
        case,
        branch,
        json!({
            "exit_case_id": case, "employee_id": employee, "status": "HR_CONFIRMED",
            "effective_exit_date": last_day.to_string(), "exit_reason_code": GROUP_TRANSFER_EXIT_REASON,
            "exit_lifecycle_event_id": event_id, "opened_by": "employee.group_transfer",
        }),
    )?;
    Ok((case, audit))
}

/// Cancels the open settlement case of the 전적 `event_id`, if any, with its
/// settlement package: the 전적 was withdrawn, replaced or rescinded. A
/// SUBMITTED case stays: what was settled and filed is kept.
///
/// # Errors
/// A database fault.
pub async fn withdraw_settlement_case(
    tx: &mut Transaction<'_, Postgres>,
    (org, actor): (OrgId, UserId),
    event_id: Uuid,
    reason: &str,
) -> Result<Option<AuditEvent>, HrError> {
    let org_uuid = *org.as_uuid();
    let open: Option<(Uuid, Option<Uuid>, String)> = sqlx::query_as(
        "SELECT id, branch_id, status FROM employee_exit_cases \
         WHERE org_id = $1 AND exit_lifecycle_event_id = $2 AND exit_reason_code = $3 \
           AND status NOT IN ('REJECTED','CANCELLED','SUBMITTED') FOR UPDATE",
    )
    .bind(org_uuid)
    .bind(event_id)
    .bind(GROUP_TRANSFER_EXIT_REASON)
    .fetch_optional(tx.as_mut())
    .await?;
    let Some((case, branch, from_status)) = open else {
        return Ok(None);
    };
    sqlx::query(
        "UPDATE employee_exit_cases SET status = 'CANCELLED', closed_by = $3, closed_at = now(), \
           closed_reason = $4, updated_at = now() WHERE org_id = $1 AND id = $2",
    )
    .bind(org_uuid)
    .bind(case)
    .bind(*actor.as_uuid())
    .bind(reason)
    .execute(tx.as_mut())
    .await?;
    sqlx::query(
        "DELETE FROM employee_exit_settlement_packages WHERE org_id = $1 AND exit_case_id = $2",
    )
    .bind(org_uuid)
    .bind(case)
    .execute(tx.as_mut())
    .await?;
    let after = json!({ "exit_case_id": case, "from_status": from_status, "status": "CANCELLED",
        "group_transfer_event_id": event_id });
    Ok(Some(event(
        actor,
        org,
        "employee.exit.cancel",
        case,
        branch,
        after,
    )?))
}

/// The refusal of a reject or cancel on a 전적's case: the 전적 is withdrawn
/// or rescinded from the person's history instead.
#[must_use]
pub fn follows_group_transfer() -> HrError {
    HrError {
        status: StatusCode::CONFLICT,
        code: "exit_case_follows_group_transfer",
        message: "this exit case is the sending legal entity's side of a group transfer; withdraw or rescind the group transfer instead".to_owned(),
        refusals: None,
    }
}
