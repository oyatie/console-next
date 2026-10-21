//! BW-11 HrService entry points: rescind one event, rescind a bulk batch, and
//! correct (정정) one event on the same date.

use console_kernel_core::{AuditAction, AuditEvent, KernelError, OrgId, TraceContext, UserId};
use console_platform_auth::{MobilePasskeyStepUpEnvelope, PasskeyService};
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use serde::Deserialize;
use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

use super::batch_undo::withdraw_scheduled;
use super::correction_authorization::authorize_sensitive_correction;
pub use super::correction_authorization::lifecycle_correction_binding;
use super::normalize::normalize_lifecycle_transition;
use super::prepare::prepare_lifecycle_event;
use super::record::record_lifecycle_event_tx;
use super::title_reason::coded;
use super::types::EmployeeLifecycleEventResponse;
use super::void::{
    RescindLifecycleEventRequest, RescindOutcome, check_void_reason, load_voidable, rescind_tx,
    restore_head,
};
use crate::authz::{
    APPOINTMENT_KEYS, authorize_hr_org_wide, authorize_hr_person_any, hr_reach_any,
};
use crate::clock::today_kst;
use crate::exits::group_transfer_case::withdraw_settlement_case;
use crate::{HrError, HrService};

/// Body of `POST …/lifecycle-events/{event_id}/correct`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CorrectLifecycleEventRequest {
    /// The event as it should have been: same type and same effective date.
    /// Keep the sent object for signing; decode the typed request before opening a transaction.
    pub replacement: Value,
    /// A `lifecycle_cancel` code (INPUT_ERROR, …).
    pub reason_code: String,
    #[serde(default)]
    pub note: Option<String>,
    /// Only the governed solo path consumes a payload-bound assertion.
    #[serde(default)]
    pub step_up: Option<MobilePasskeyStepUpEnvelope>,
}

fn audit(
    org: OrgId,
    actor: UserId,
    action: &str,
    (target, id): (&str, Uuid),
    snapshot: Value,
) -> Result<AuditEvent, HrError> {
    Ok(AuditEvent::new(
        Some(actor),
        AuditAction::new(action).map_err(HrError::from_kernel)?,
        target,
        id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(None, Some(snapshot)))
}

impl HrService {
    /// `POST /employees/{id}/lifecycle-events/{event_id}/rescind`.
    pub async fn rescind_lifecycle_event(
        &self,
        principal: Principal,
        employee_id: Uuid,
        event_id: Uuid,
        request: RescindLifecycleEventRequest,
    ) -> Result<RescindOutcome, HrError> {
        hr_reach_any(&principal, &APPOINTMENT_KEYS)?;
        let (org, actor) = (principal.org_id, principal.user_id);
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                authorize_hr_person_any(tx, &principal, &APPOINTMENT_KEYS, employee_id).await?;
                check_void_reason(tx, org, &request.reason_code, request.note.as_deref()).await?;
                let outcome =
                    rescind_tx(tx, org, actor, employee_id, event_id, &request, None).await?;
                let audits = match &outcome.rescinded {
                    Some(row) => {
                        // A rescinded 전적 takes its open settlement case with it.
                        let why = request
                            .note
                            .as_deref()
                            .map(str::trim)
                            .filter(|n| !n.is_empty());
                        let why = why.unwrap_or(request.reason_code.trim());
                        let case =
                            withdraw_settlement_case(tx, (org, actor), event_id, why).await?;
                        std::iter::once(audit(
                            org,
                            actor,
                            "employee.lifecycle.rescind",
                            ("employee", employee_id),
                            json!({"lifecycle_event_id": row.id, "voids_event_id": event_id,
                                   "reason_code": request.reason_code.trim()}),
                        )?)
                        .chain(case)
                        .collect()
                    }
                    None => vec![],
                };
                Ok((outcome, audits))
            })
        })
        .await
    }

    /// `POST /employees/lifecycle-events/bulk/{batch_id}/rescind`: every event
    /// of the batch, all or nothing; a refusal names each employee.
    pub async fn rescind_lifecycle_batch(
        &self,
        principal: Principal,
        batch_id: Uuid,
        request: RescindLifecycleEventRequest,
    ) -> Result<Vec<RescindOutcome>, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let (org, actor) = (principal.org_id, principal.user_id);
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                check_void_reason(tx, org, &request.reason_code, request.note.as_deref()).await?;
                // A dated batch's reservations are withdrawn with it (EMP-UI 8).
                let events: Vec<(Uuid, Uuid, bool)> = sqlx::query_as(
                    "SELECT employee_id, id, state = 'SCHEDULED' FROM employee_lifecycle_events \
                     WHERE org_id = $1 AND batch_id = $2 AND event_type <> 'RESCIND' \
                       AND state IN ('APPLIED', 'SCHEDULED') ORDER BY employee_id",
                )
                .bind(org.as_uuid())
                .bind(batch_id)
                .fetch_all(tx.as_mut())
                .await?;
                if events.is_empty() {
                    return Err(HrError::from_kernel(KernelError::not_found(
                        "batch not found",
                    )));
                }
                let rescind_batch = Uuid::new_v4();
                let (mut outcomes, mut refusals) = (Vec::new(), Vec::new());
                for (employee, event, scheduled) in &events {
                    let undone = if *scheduled {
                        withdraw_scheduled(tx, (org, actor), *employee, *event, &request).await
                    } else {
                        let batch = Some(rescind_batch);
                        rescind_tx(tx, org, actor, *employee, *event, &request, batch).await
                    };
                    match undone {
                        Ok(outcome) => outcomes.push(outcome),
                        Err(error) if error.status.is_client_error() => refusals.push(json!({
                            "employee_id": employee, "code": error.code, "message": error.message,
                        })),
                        Err(error) => return Err(error),
                    }
                }
                if !refusals.is_empty() {
                    return Err(HrError::bulk_refused(refusals, events.len()));
                }
                let audits = if request.confirm_cascades {
                    vec![audit(
                        org,
                        actor,
                        "employee.lifecycle.bulk_rescind",
                        ("employee_lifecycle_batch", batch_id),
                        json!({"batch_id": batch_id, "rescind_batch_id": rescind_batch,
                               "count": events.len(), "reason_code": request.reason_code.trim()}),
                    )?]
                } else {
                    vec![]
                };
                Ok((outcomes, audits))
            })
        })
        .await
    }

    /// `POST /employees/{id}/lifecycle-events/{event_id}/correct`: undo the
    /// event and record its replacement on the same date, in one transaction.
    pub async fn correct_lifecycle_event(
        &self,
        principal: Principal,
        employee_id: Uuid,
        event_id: Uuid,
        request: CorrectLifecycleEventRequest,
        passkeys: Option<&PasskeyService>,
    ) -> Result<EmployeeLifecycleEventResponse, HrError> {
        hr_reach_any(&principal, &APPOINTMENT_KEYS)?;
        let binding = lifecycle_correction_binding(employee_id, event_id, &request);
        let replacement = serde_json::from_value(request.replacement)
            .map_err(|error| HrError::validation(error.to_string()))?;
        let transition = normalize_lifecycle_transition(replacement)?;
        let passkeys = passkeys.cloned();
        let (org, actor) = (principal.org_id, principal.user_id);
        let org_uuid = *org.as_uuid();
        let today = today_kst();
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                authorize_hr_person_any(tx, &principal, &APPOINTMENT_KEYS, employee_id).await?;
                check_void_reason(tx, org, &request.reason_code, request.note.as_deref()).await?;
                let original = load_voidable(tx, org_uuid, employee_id, event_id).await?;
                if original.event_type == "GROUP_TRANSFER" {
                    return Err(coded(
                        KernelError::invalid_transition(
                            "a 전적 is rescinded and recorded again, not corrected",
                        )
                        .with_code("lifecycle_void_unsupported"),
                    ));
                }
                if transition.event_type != original.event_type
                    || transition.effective_date != original.effective_date
                {
                    return Err(HrError::validation(
                        "a correction keeps the event's type and effective_date; rescind it to change them",
                    ));
                }
                let date = |d: Option<time::Date>| d.map(|d| d.to_string());
                let assertion = if transition.contract_end_date != date(original.contract_end_date)
                    || transition.expected_return_date != date(original.expected_return_date)
                {
                    authorize_sensitive_correction(
                        tx, &principal, employee_id, event_id, passkeys.as_ref(), request.step_up, &binding,
                    ).await?
                } else { None };
                // The undo of a 전근 is its own assignment command (E-S3b).
                let undo = (*actor.as_uuid(), Uuid::new_v4());
                restore_head(tx, org_uuid, employee_id, &original, undo).await?;
                let mut prepared =
                    prepare_lifecycle_event(tx, org_uuid, employee_id, transition, today).await?;
                prepared.voids_event_id = Some(original.id);
                let (item, recorded) =
                    record_lifecycle_event_tx(tx, org, actor, employee_id, &prepared, None).await?;
                let corrected = audit(org, actor, "employee.lifecycle.correct", ("employee", employee_id),
                    json!({"lifecycle_event_id": item.id, "voids_event_id": original.id,
                           "reason_code": request.reason_code.trim(), "review_required": assertion.is_some(),
                           "step_up_assertion_id": assertion}))?;
                Ok((item, vec![recorded, corrected]))
            })
        })
        .await
    }
}
