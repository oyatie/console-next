//! The exit ends the person's 법인 · 사업장 assignment (UX-R3 STRUCT
//! company-01, records-04): confirming it ends the live row the day after the
//! 마지막 근무일, and reversing it reopens that row. The entity crate writes
//! the rows (ADR-004); the caller holds the employee `FOR UPDATE`.

use console_entity_adapter_postgres::employment_end::{end_on_exit_in_tx, reopen_on_exit_in_tx};
use console_entity_adapter_postgres::employment_moves::MoveWrite;
use console_hr_domain::exits::case::ExitCaseContext;
use console_hr_domain::text::parse_yyyy_mm_dd;
use console_kernel_core::UserId;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::HrError;

fn write(org: Uuid, actor: UserId, context: &ExitCaseContext, command: Uuid) -> MoveWrite {
    MoveWrite {
        org_id: org,
        employee_id: context.employee_id,
        actor_id: *actor.as_uuid(),
        command_id: command,
    }
}

/// End the assignment the exit `event` (its TERMINATE) closes.
pub(crate) async fn end_assignment(
    conn: &mut PgConnection,
    org: Uuid,
    actor: UserId,
    context: &ExitCaseContext,
    event: Uuid,
) -> Result<(), HrError> {
    let last_day = parse_yyyy_mm_dd(&context.effective_exit_date).map_err(HrError::from_kernel)?;
    end_on_exit_in_tx(conn, write(org, actor, context, event), last_day)
        .await
        .map_err(HrError::from_kernel)?;
    Ok(())
}

/// Reopen what [`end_assignment`] ended, when the exit is withdrawn.
pub(crate) async fn reopen_assignment(
    conn: &mut PgConnection,
    org: Uuid,
    actor: UserId,
    context: &ExitCaseContext,
) -> Result<(), HrError> {
    let last_day = parse_yyyy_mm_dd(&context.effective_exit_date).map_err(HrError::from_kernel)?;
    reopen_on_exit_in_tx(conn, write(org, actor, context, Uuid::new_v4()), last_day)
        .await
        .map_err(HrError::from_kernel)?;
    Ok(())
}
