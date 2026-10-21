//! HrService::cancel_lifecycle_event: handler body moved verbatim from
//! `app/src/hr.rs` (R2-life).

use console_hr_domain::lifecycle::schedule::ScheduleChange;
use console_hr_domain::text::normalize_limited_text;
use console_kernel_core::{AuditAction, AuditEvent, KernelError, TraceContext};
use console_platform_authz::Principal;
use console_platform_db::with_audits;
use serde_json::json;
use time::OffsetDateTime;
use uuid::Uuid;

use super::record::{cancel_scheduled_lifecycle_event_tx, load_lifecycle_event};
use super::requests::CancelLifecycleEventRequest;
use super::rules::lifecycle_refusal;
use super::schedule_sql::replay_lifecycle_schedule;
use super::store::load_employee_for_lifecycle;
use super::types::EmployeeLifecycleEventResponse;
use crate::authz::{APPOINTMENT_KEYS, authorize_hr_person_any, hr_reach_any};
use crate::exits::group_transfer_case::withdraw_settlement_case;
use crate::{HrError, HrService};

impl HrService {
    /// `POST /employees/{id}/lifecycle-events/{event_id}/cancel`: withdraw a
    /// SCHEDULED event before its date. A scheduled exit belongs to its exit case
    /// and is withdrawn by cancelling or rejecting that case; a scheduled 전적
    /// takes the sending 법인's settlement case with it.
    pub async fn cancel_lifecycle_event(
        &self,
        principal: Principal,
        employee_id: Uuid,
        event_id: Uuid,
        body: CancelLifecycleEventRequest,
    ) -> Result<EmployeeLifecycleEventResponse, HrError> {
        hr_reach_any(&principal, &APPOINTMENT_KEYS)?;
        let reason = normalize_limited_text(body.reason, 1000, "reason")?;
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        let actor = principal.user_id;
        let item = with_audits::<_, _, HrError>(&self.pool, org, |tx| {
            Box::pin(async move {
                authorize_hr_person_any(tx, &principal, &APPOINTMENT_KEYS, employee_id).await?;
                let live = load_employee_for_lifecycle(tx, org_uuid, employee_id).await?;
                let row: Option<(String, bool)> = sqlx::query_as(
                    "SELECT l.state, l.event_type <> 'GROUP_TRANSFER' AND EXISTS (SELECT 1 FROM employee_exit_cases c \
                   WHERE c.org_id = l.org_id AND c.exit_lifecycle_event_id = l.id) \
                 FROM employee_lifecycle_events l \
                 WHERE l.org_id = $1 AND l.employee_id = $2 AND l.id = $3 FOR UPDATE OF l",
                )
                .bind(org_uuid)
                .bind(employee_id)
                .bind(event_id)
                .fetch_optional(tx.as_mut())
                .await?;
                let Some((event_state, owned_by_exit_case)) = row else {
                    return Err(HrError::from_kernel(KernelError::not_found(
                        "lifecycle event not found",
                    )));
                };
                if event_state != "SCHEDULED" {
                    return Err(lifecycle_refusal(
                        "only a SCHEDULED lifecycle event can be cancelled",
                    ));
                }
                if owned_by_exit_case {
                    return Err(lifecycle_refusal(
                        "a scheduled exit is withdrawn by cancelling or rejecting its exit case",
                    ));
                }
                // Later events that only apply after this one (a return after
                // this leave) refuse the cancel, naming each.
                replay_lifecycle_schedule(
                    tx,
                    org_uuid,
                    employee_id,
                    &live,
                    ScheduleChange::Withdraw(event_id),
                )
                .await?;
                cancel_scheduled_lifecycle_event_tx(tx, org_uuid, event_id, actor, &reason).await?;
                let case = withdraw_settlement_case(tx, (org, actor), event_id, &reason).await?;
                let item = load_lifecycle_event(tx, org_uuid, event_id).await?;
                let audit = AuditEvent::new(
                    Some(actor),
                    AuditAction::new("employee.lifecycle.cancel").map_err(HrError::from_kernel)?,
                    "employee",
                    employee_id.to_string(),
                    TraceContext::generate(),
                    OffsetDateTime::now_utc(),
                )
                .with_org(org)
                .with_snapshots(
                    None,
                    Some(json!({
                        "lifecycle_event_id": event_id,
                        "event_type": &item.event_type,
                        "effective_date": &item.effective_date,
                    })),
                );
                Ok((item, std::iter::once(audit).chain(case).collect()))
            })
        })
        .await?;
        Ok(item)
    }
}
