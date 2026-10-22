//! HrService::close_exit_case: reject or cancel.
//! Handler body moved verbatim from `app/src/hr.rs` (R2-exits).

use console_hr_domain::text::normalize_limited_text;
use console_kernel_core::KernelError;
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use serde_json::json;
use uuid::Uuid;

use crate::authz::authorize_hr_scoped_write;
use crate::exits::audit::exit_case_audit_event;
use crate::exits::group_transfer_case::{GROUP_TRANSFER_EXIT_REASON, follows_group_transfer};
use crate::exits::queries::load_exit_case_by_id;
use crate::exits::store::{load_exit_case_context, reverse_exit_lifecycle_event};
use crate::exits::types::{CloseEmployeeExitCaseRequest, EmployeeExitCaseResponse};
use crate::own_record::own_record_guard;
use crate::{HrError, HrService};

impl HrService {
    /// Close an exit case as REJECTED or CANCELLED. When HR confirmation already
    /// exited the employee, rejection records a compensating EXIT_REVERSAL restoring
    /// the status the exit replaced, in the same audited transaction. A linked
    /// absence alert reopens so the absence can be handled again.
    pub async fn close_exit_case(
        &self,
        principal: Principal,
        case_id: Uuid,
        body: CloseEmployeeExitCaseRequest,
        to_status: &'static str,
    ) -> Result<EmployeeExitCaseResponse, HrError> {
        let reason = normalize_limited_text(body.reason, 1000, "reason")?;
        let reader = principal.clone();
        let actor = principal.user_id;
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        let rejecting = to_status == "REJECTED";

        let exit_case = with_audits::<_, _, HrError>(&self.pool, org, |tx| {
        Box::pin(async move {
            let context = load_exit_case_context(tx, org_uuid, case_id, true).await?;
            let holds =
                |feature| authorize_hr_scoped_write(&principal, feature, context.branch_id).is_ok();
            let (authorized, open_states): (bool, &[&str]) = if rejecting {
                (
                    holds(Feature::ExitCaseHrConfirm) || holds(Feature::ExitCaseHqConfirm),
                    &[
                        "REPORTED",
                        "HR_CONFIRMED",
                        "HQ_CONFIRMED",
                        "SETTLEMENT_READY",
                        "APPROVAL_DRAFTED",
                    ],
                )
            } else {
                (
                    holds(Feature::ExitCaseHrConfirm) || holds(Feature::ExitCaseReport),
                    &["REPORTED"],
                )
            };
            if !authorized {
                return Err(HrError::from_kernel(KernelError::forbidden(if rejecting {
                    "rejecting an exit case requires an exit-case confirmation capability"
                } else {
                    "cancelling an exit case requires the reporter or HR confirmation capability"
                })));
            }
            own_record_guard(tx, org, actor, context.employee_id, Feature::ExitCaseHrConfirm).await?;
            // A 전적's case goes back with the 전적, unless the 전적 failed to
            // apply on its date: then nothing happened and the case closes alone.
            let follows: bool = sqlx::query_scalar(
                "SELECT c.exit_reason_code IS NOT DISTINCT FROM $3 AND l.state IS DISTINCT FROM 'APPLY_FAILED' \
                 FROM employee_exit_cases c LEFT JOIN employee_lifecycle_events l \
                   ON l.org_id = c.org_id AND l.id = c.exit_lifecycle_event_id \
                 WHERE c.org_id = $1 AND c.id = $2",
            )
            .bind(org_uuid)
            .bind(case_id)
            .bind(GROUP_TRANSFER_EXIT_REASON)
            .fetch_one(tx.as_mut())
            .await?;
            if follows {
                return Err(follows_group_transfer());
            }
            if !rejecting && matches!(context.status.as_str(),
                "HR_CONFIRMED" | "HQ_CONFIRMED" | "SETTLEMENT_READY" | "APPROVAL_DRAFTED" | "SUBMITTED") {
                return Err(HrError {
                    status: http::StatusCode::CONFLICT,
                    code: "exit_cancel_after_hr_confirmation",
                    message: "an HR-confirmed exit report cannot be cancelled; reject with a reason where available, otherwise request a governed correction".to_owned(),
                    refusals: None,
                });
            }
            if !open_states.contains(&context.status.as_str()) {
                return Err(HrError::from_kernel(KernelError::invalid_transition(
                    if rejecting {
                        "only an open exit case (REPORTED through APPROVAL_DRAFTED) can be rejected"
                    } else {
                        "only a REPORTED exit case can be cancelled"
                    },
                )));
            }

            let reversal =
                reverse_exit_lifecycle_event(tx, org_uuid, actor, &context, &reason).await?;
            sqlx::query(
                r#"
                UPDATE employee_exit_cases
                SET status = $3,
                    closed_by = $4,
                    closed_at = now(),
                    closed_reason = $5,
                    updated_at = now()
                WHERE org_id = $1 AND id = $2
                "#,
            )
            .bind(org_uuid)
            .bind(case_id)
            .bind(to_status)
            .bind(*actor.as_uuid())
            .bind(&reason)
            .execute(tx.as_mut())
            .await?;
            sqlx::query(
                r#"
                UPDATE employee_absence_alerts
                SET status = 'OPEN',
                    linked_exit_case_id = NULL,
                    updated_at = now()
                WHERE org_id = $1 AND linked_exit_case_id = $2
                "#,
            )
            .bind(org_uuid)
            .bind(case_id)
            .execute(tx.as_mut())
            .await?;
            // A closed case settles nothing: its settlement package (and any
            // drafted approval payload) goes with it.
            sqlx::query(
                "DELETE FROM employee_exit_settlement_packages WHERE org_id = $1 AND exit_case_id = $2",
            )
            .bind(org_uuid)
            .bind(case_id)
            .execute(tx.as_mut())
            .await?;

            let exit_case = load_exit_case_by_id(tx, org_uuid, case_id).await?;
            let event = exit_case_audit_event(
                actor,
                org,
                if rejecting {
                    "employee.exit.reject"
                } else {
                    "employee.exit.cancel"
                },
                &context,
                json!({
                    "exit_case_id": case_id,
                    "from_status": &context.status,
                    "status": to_status,
                    "reversal_lifecycle_event_id": reversal.as_ref().map(|(id, _)| id),
                    "restored_employment_status": reversal.as_ref().map(|(_, status)| status),
                }),
            )?;
            Ok((exit_case, vec![event]))
        })
    })
    .await?;

        Ok(exit_case.for_reader(&reader))
    }
}
