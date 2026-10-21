//! The SCHEDULED half of a batch undo (EMP-UI 8, 11; spec E6-done 묶음
//! 되돌리기): a dated batch's reservations are withdrawn, as the single
//! cancel withdraws one, inside the batch rescind's transaction. The
//! employee's later reservations that only apply after this one refuse it
//! (409 `lifecycle_schedule_conflict`), so the batch stays all or nothing.

use console_hr_domain::lifecycle::schedule::ScheduleChange;
use console_kernel_core::{OrgId, UserId};
use uuid::Uuid;

use super::record::{cancel_scheduled_lifecycle_event_tx, load_lifecycle_event};
use super::schedule_sql::replay_lifecycle_schedule;
use super::store::load_employee_for_lifecycle;
use super::void::{RescindLifecycleEventRequest, RescindOutcome};
use crate::HrError;

/// Withdraws one SCHEDULED event of the batch; without `confirm_cascades`
/// only checks that it could be (no write).
pub(super) async fn withdraw_scheduled(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    (org, actor): (OrgId, UserId),
    employee_id: Uuid,
    event_id: Uuid,
    request: &RescindLifecycleEventRequest,
) -> Result<RescindOutcome, HrError> {
    let org_uuid = *org.as_uuid();
    let live = load_employee_for_lifecycle(tx, org_uuid, employee_id).await?;
    let change = ScheduleChange::Withdraw(event_id);
    replay_lifecycle_schedule(tx, org_uuid, employee_id, &live, change).await?;
    if !request.confirm_cascades {
        return Ok(RescindOutcome {
            cascades: Vec::new(),
            rescinded: None,
        });
    }
    let note = request
        .note
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty());
    let reason = note.unwrap_or_else(|| request.reason_code.trim());
    cancel_scheduled_lifecycle_event_tx(tx, org_uuid, event_id, actor, reason).await?;
    Ok(RescindOutcome {
        cascades: Vec::new(),
        rescinded: Some(load_lifecycle_event(tx, org_uuid, event_id).await?),
    })
}
