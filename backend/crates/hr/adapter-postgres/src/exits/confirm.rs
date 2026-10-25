//! HrService::confirm_exit_case: the two-tier confirmation.
//! Handler body moved verbatim from `app/src/hr.rs` (R2-exits).

use console_hr_domain::exits::case::ExitCaseContext;
use console_hr_domain::text::normalize_optional_limited_text;
use console_identity_application::{RevokeMode, access_end};
use console_kernel_core::{AuditEvent, KernelError, OrgId, Resolved, UserId};
use console_platform_auth::{MobilePasskeyStepUpBinding, MobileStepUpActionKind, PasskeyService};
use console_platform_authz::access::revoke_privileged_access;
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use console_settings_adapter_postgres::{approval_routes_in_tx, resolve_in_tx};
use console_settings_domain::{SettingKey, SettingValue};
use serde_json::json;
use sqlx::{Postgres, Transaction};
use time::{Date, OffsetDateTime, macros::format_description};
use uuid::Uuid;

use crate::authz::{
    HqSecondPerson, authorize_hr_case, authorize_hr_scoped_write, exit_hq_second_person,
};
use crate::corrections::refusal;
use crate::digest::sha256_hex;
use crate::exits::audit::exit_case_audit_event;
use crate::exits::queries::load_exit_case_by_id;
use crate::exits::settlement_store::upsert_exit_settlement_package;
use crate::exits::store::{insert_confirmed_exit_lifecycle_event, load_exit_case_context};
use crate::exits::types::{ConfirmEmployeeExitCaseRequest, EmployeeExitCaseResponse};
use crate::own_record::own_record_guard;
use crate::{HrError, HrService};

/// The payload an ops break-glass HQ confirmation's step-up is bound to.
pub const EXIT_HQ_PAYLOAD: &str = r#"{"hq_confirmation":true}"#;

/// The step-up binding for the ops account's HQ confirmation of `case_id`.
#[must_use]
pub fn exit_hq_binding(case_id: Uuid) -> MobilePasskeyStepUpBinding {
    let kind = MobileStepUpActionKind::ExitConfirm;
    MobilePasskeyStepUpBinding {
        action_kind: kind,
        object_id: case_id,
        reason_key: kind.expected_reason_key().to_owned(),
        replay_attempt: None,
        payload_hash: Some(sha256_hex(EXIT_HQ_PAYLOAD.as_bytes())),
    }
}

fn unauthorized(code: &'static str, message: &str) -> HrError {
    refusal(http::StatusCode::UNAUTHORIZED, code, message)
}

impl HrService {
    // M2-strangler-debt: this absence->exit->settlement flow is a hardcoded cross-module
    // decision spine (report -> HR confirm -> HQ confirm -> settlement -> approval). It is the
    // SECOND such flow (after completion->approval->payroll) slated to migrate onto the ADR-0018
    // workflow runtime spine (workflow_runs / workflow_node_runs / workflow_waiting_tasks /
    // workflow_outbox_events). State machine -> spine-IR mapping: exit_case.status transitions map
    // to workflow_node_runs; the two-tier confirm maps to workflow_waiting_tasks with required_policy
    // guards; the settlement/certification side effects map to idempotency-keyed workflow_outbox_events.
    // See .omc/plans/ralplan-pr166-completion.md S8.2 (M2 charter follow-up). Migration is mechanical,
    // not a rewrite, once the M2 executor lands.
    pub async fn confirm_exit_case(
        &self,
        principal: Principal,
        passkeys: Option<&PasskeyService>,
        case_id: Uuid,
        body: ConfirmEmployeeExitCaseRequest,
    ) -> Result<EmployeeExitCaseResponse, HrError> {
        let passkeys = passkeys.cloned();
        let mut body = body;
        let envelope = body.step_up.take();
        let reader = principal.clone();
        let actor = principal.user_id;
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        let note = normalize_optional_limited_text(body.note, 1000, "note")?;

        let exit_case = with_audits::<_, _, HrError>(&self.pool, org, |tx| {
        Box::pin(async move {
            let context = load_exit_case_context(tx, org_uuid, case_id, true).await?;
            let mut involuntary = false;
            let mut hq_second_person = None;
            let mut step_up_assertion = None;

            // Two-tier separation of duties enforced in CODE — the client
            // `hq_confirmation` boolean only selects which tier is attempted; the
            // capability + stored-state + distinct-actor checks are the authority.
            let exit_lifecycle_event_id = if body.hq_confirmation {
                authorize_hr_scoped_write(&principal, Feature::ExitCaseHqConfirm, context.branch_id)
                    .map_err(|_| {
                        HrError::from_kernel(KernelError::forbidden(
                            "HQ confirmation requires the exit-case HQ confirmation capability",
                        ))
                    })?;
                own_record_guard(tx, org, actor, context.employee_id, Feature::ExitCaseHqConfirm).await?;
                if body.exit_reason_code.is_some() || body.dismissal_notice.is_some() || body.notice_disposition.is_some() {
                    return Err(HrError::validation("exit reason and dismissal notice belong to HR confirmation"));
                }
                let routed = approval_routes_in_tx(tx.as_mut(), org, SettingKey::ApprovalPolicyExit)
                    .await
                    .map_err(HrError::from_kernel)?;
                let second = exit_hq_second_person(
                    &context.status,
                    context.hr_confirmed_by,
                    *actor.as_uuid(),
                    routed,
                    principal.is_tenant_ops,
                )?;
                if second == HqSecondPerson::OpsBreakGlass {
                    let envelope = envelope.ok_or_else(|| {
                        unauthorized(
                            "step_up_required",
                            "the ops account confirming its own HR confirmation needs a passkey step-up",
                        )
                    })?;
                    let passkeys = passkeys.as_ref().ok_or_else(|| {
                        refusal(
                            http::StatusCode::SERVICE_UNAVAILABLE,
                            "step_up_unavailable",
                            "passkey step-up is not configured",
                        )
                    })?;
                    let assertion = passkeys
                        .verify_and_record_step_up_in_tx(
                            tx,
                            envelope,
                            *actor.as_uuid(),
                            &exit_hq_binding(case_id),
                        )
                        .await
                        .map_err(|_| {
                            unauthorized("step_up_failed", "the passkey step-up did not verify")
                        })?;
                    step_up_assertion = Some(assertion);
                }
                hq_second_person = Some(second);
                None
            } else {
                authorize_hr_case(tx, &principal, Feature::ExitCaseHrConfirm, context.branch_id, context.employee_id).await
                    .map_err(|_| {
                        HrError::from_kernel(KernelError::forbidden(
                            "HR confirmation requires the exit-case HR confirmation capability",
                        ))
                    })?;
                if context.status != "REPORTED" {
                    return Err(HrError::from_kernel(KernelError::invalid_transition(
                        "HR confirmation requires a REPORTED exit case",
                    )));
                }
                let class = super::reason::confirmation_reason(tx, org, &context, body.exit_reason_code.as_deref()).await?;
                super::guards::check_exit_guards(tx.as_mut(), org, context.employee_id, &context.effective_exit_date, &class, body.dismissal_notice.as_ref(), "confirm", body.notice_disposition.as_ref()).await?;
                let notice = super::notice::checked_notice(class.notice_required, body.dismissal_notice, super::guards::termination_date(&context.effective_exit_date)?)?;
                super::notice::save_facts(tx, org_uuid, case_id, &class.code, notice.as_ref(), body.notice_disposition.as_ref()).await?;
                involuntary = class.involuntary;
                // HR confirmation is the exit: it records the TERMINATE event
                // (the only route to EXITED) that a later reject/cancel reverses.
                insert_confirmed_exit_lifecycle_event(
                    tx,
                    org,
                    actor,
                    &context,
                    note.as_deref(),
                    body.signoffs.clone(),
                )
                .await?
            };

            let next_status = if body.hq_confirmation {
                "HQ_CONFIRMED"
            } else {
                "HR_CONFIRMED"
            };
            sqlx::query(
                r#"
                UPDATE employee_exit_cases
                SET status = $3,
                    hr_confirmed_by = COALESCE(hr_confirmed_by, $4),
                    hr_confirmed_at = COALESCE(hr_confirmed_at, now()),
                    hq_confirmed_by = CASE WHEN $5 THEN $4 ELSE hq_confirmed_by END,
                    hq_confirmed_at = CASE WHEN $5 THEN COALESCE(hq_confirmed_at, now()) ELSE hq_confirmed_at END,
                    confirmation_note = $6,
                    exit_lifecycle_event_id = COALESCE(exit_lifecycle_event_id, $7),
                    updated_at = now()
                WHERE org_id = $1 AND id = $2
                "#,
            )
            .bind(org_uuid)
            .bind(case_id)
            .bind(next_status)
            .bind(*actor.as_uuid())
            .bind(body.hq_confirmation)
            .bind(note.as_deref())
            .bind(exit_lifecycle_event_id)
            .execute(tx.as_mut())
            .await?;

            crate::cases::open::initialise(tx,org_uuid,case_id).await?;

            // governance-04: the HR confirmation is the exit, so the leaver's
            // access ends with it, in this transaction.
            let mut events = if body.hq_confirmation {
                Vec::new()
            } else {
                end_leaver_access(tx, org, actor, &context, involuntary).await?
            };
            upsert_exit_settlement_package(tx, org_uuid, case_id, body.settlement_input.clone())
                .await?;
            if !body.hq_confirmation {
                crate::cases::observe::access(tx, org, actor, case_id, &mut events).await?;
            }
            let exit_case = load_exit_case_by_id(tx, org_uuid, case_id).await?;
            let event = exit_case_audit_event(
                actor,
                org,
                "employee.exit.confirm",
                &context,
                json!({
                    "exit_case_id": case_id,
                    "hq_confirmation": body.hq_confirmation,
                    "status": &exit_case.status,
                    "involuntary": exit_case.involuntary,
                    "notice_required": exit_case.notice_required,
                    "dismissal_notice": &exit_case.dismissal_notice,
                    "notice_disposition": &exit_case.notice_disposition,
                    "exit_lifecycle_event_id": exit_lifecycle_event_id,
                    // decisions #26 item d: who stood as the HQ second person.
                    "hq_second_person": hq_second_person.map(|p| match p {
                        HqSecondPerson::NotRequired => "not_required",
                        HqSecondPerson::Distinct => "distinct",
                        HqSecondPerson::OpsBreakGlass => "ops_break_glass",
                    }),
                    "review_required": hq_second_person == Some(HqSecondPerson::OpsBreakGlass),
                    "step_up_assertion_id": step_up_assertion,
                }),
            )?;
            events.push(event);
            Ok((exit_case, events))
        })
    })
    .await?;

        Ok(exit_case.for_reader(&reader))
    }
}

/// End access at the instant configured for the validated reason class.
async fn end_leaver_access(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    context: &ExitCaseContext,
    involuntary: bool,
) -> Result<Vec<AuditEvent>, HrError> {
    let now = OffsetDateTime::now_utc();
    let key = if involuntary {
        SettingKey::ExitAccessRevokeModeInvoluntary
    } else {
        SettingKey::ExitAccessRevokeModeVoluntary
    };
    let resolved = resolve_in_tx(tx.as_mut(), org, &[key], None, now)
        .await
        .map_err(HrError::from_kernel)?;
    let mode = match resolved.get(&key) {
        Some(Ok(Resolved {
            value: SettingValue::Code(code),
            ..
        })) => RevokeMode::from_code(code),
        _ => RevokeMode::OnConfirm,
    };
    let exit_date = Date::parse(
        &context.effective_exit_date,
        format_description!("[year]-[month]-[day]"),
    )
    .map_err(|_| HrError::from_kernel(KernelError::internal("exit date is not a date")))?;
    let ends_at = access_end(mode, exit_date, now);
    let (_, events) = revoke_privileged_access(tx, org, context.employee_id, ends_at, actor, now)
        .await
        .map_err(HrError::from_kernel)?;
    Ok(events)
}
