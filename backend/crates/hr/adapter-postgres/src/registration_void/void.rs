//! `POST /employees/{id}/void` after 운영 시작: 등록 취소 of a person who never
//! started, or of a fresh registration nobody worked on (onboarding design
//! §7.3). Governed like a high-risk 정정: a second person decides a filed
//! EMPLOYEE_VOID request, or a sole holder voids after a step-up bound to
//! this employee and payload, flagged for review (decisions #7 case B). The
//! record stays as a hidden VOIDED tombstone with its 사번; the rest of its
//! personal data goes after `people.void_pii_retention`.

use console_hr_domain::corrections::HighRiskPath;
use console_hr_domain::registration_void::{VoidFacts, void_basis};
use console_hr_domain::requests::ChangeRequestKind;
use console_kernel_core::WriteClass;
use console_ontology_canonical_adapter_postgres::employee_void::VoidMark;
use console_platform_auth::{MobilePasskeyStepUpBinding, MobileStepUpActionKind, PasskeyService};
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use console_settings_domain::SettingKey;
use http::StatusCode;
use serde_json::json;
use uuid::Uuid;

use super::apply::{void_event, void_in_tx};
use super::facts::{admit, check_version, int_setting, lock, today_kst};
use super::{VoidEmployeeRequest, VoidOutcome, void_payload};
use crate::authz::authorize_hr_org_wide;
use crate::corrections::{SecondPersonContext, refusal};
use crate::digest::sha256_hex;
use crate::lifecycle::title_reason::coded;
use crate::requests::cedar::sole_holder_cedar;
use crate::requests::create::{NewChangeRequest, insert_change_request_in_tx};
use crate::requests::{note, reason_code};
use crate::{HrError, HrService};

/// The step-up binding of a sole holder's void, as the correction's
/// (`corrections::patch::correction_binding`): EXCEPTION_DECIDE bound to the
/// employee and the payload hash, so it cannot be replayed elsewhere.
#[must_use]
pub fn void_binding(employee_id: Uuid, attest_never_worked: bool) -> MobilePasskeyStepUpBinding {
    let kind = MobileStepUpActionKind::ExceptionDecide;
    MobilePasskeyStepUpBinding {
        action_kind: kind,
        object_id: employee_id,
        reason_key: kind.expected_reason_key().to_owned(),
        replay_attempt: None,
        payload_hash: Some(sha256_hex(void_payload(attest_never_worked).as_bytes())),
    }
}

impl HrService {
    /// # Errors
    /// 403 without org-wide `employee_directory_manage`, or
    /// `employee_void_sole_holder_refused`; 401 `step_up_required` /
    /// `step_up_failed` for a sole holder; 409 `phase_not_operating` (SETUP:
    /// delete instead) and the `employee_void_*` refusals; 404 for an unknown
    /// or already voided record.
    pub async fn void_employee(
        &self,
        principal: Principal,
        passkeys: &PasskeyService,
        employee_id: Uuid,
        body: VoidEmployeeRequest,
        holders: SecondPersonContext,
    ) -> Result<VoidOutcome, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let reason = reason_code(&body.reason_code, "reason_code")?;
        let note = note(body.note.as_deref())?;
        let passkeys = passkeys.clone();
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        let me = *principal.user_id.as_uuid();
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                admit(tx, org_uuid, WriteClass::Operational).await?;
                let locked = lock(tx, org_uuid, employee_id).await?;
                check_version(&locked, &body.expected_updated_at)?;
                let window = int_setting(tx, org_uuid, SettingKey::PeopleVoidWindow).await?;
                let today = today_kst(tx).await?;
                let attest = body.attest_never_worked;
                let basis = void_basis(
                    VoidFacts {
                        employment_status: &locked.status,
                        registered_on: locked.registered_on,
                        has_work_records: locked.has_work_records,
                    },
                    today,
                    window,
                    attest,
                )
                .map_err(coded)?;
                let path = holders.path()
                    .ok_or_else(|| {
                        refusal(
                            StatusCode::FORBIDDEN,
                            "employee_void_sole_holder_refused",
                            "no second person can approve this void and the organization refuses sole-holder decisions",
                        )
                    })?;
                let mut after = json!({
                    "employee_number": locked.employee_number,
                    "basis": basis.as_str(),
                    "reason_code": &reason,
                });
                if path == HighRiskPath::SecondPerson {
                    let request = insert_change_request_in_tx(
                        tx,
                        NewChangeRequest {
                            org: org_uuid,
                            kind: ChangeRequestKind::EmployeeVoid,
                            subject_type: "EMPLOYEE",
                            subject_id: employee_id,
                            payload: &json!({ "attest_never_worked": attest }),
                            reason_code: &reason,
                            note: note.as_deref(),
                            requested_by: me,
                            assignee_user_id: None,
                        },
                    )
                    .await?;
                    after["change_request_id"] = json!(request.id);
                    let event = void_event(&principal, "employee.void_request", employee_id, after)?;
                    let outcome = VoidOutcome {
                        employee_id,
                        status: "PENDING",
                        voided_at: None,
                        review_required: false,
                        pending_request: Some(request),
                    };
                    return Ok((outcome, vec![event]));
                }
                let envelope = body.step_up.ok_or_else(|| {
                    refusal(
                        StatusCode::UNAUTHORIZED,
                        "step_up_required",
                        "a sole holder's void needs a passkey step-up",
                    )
                })?;
                let assertion = passkeys
                    .verify_and_record_step_up_in_tx(tx, envelope, me, &void_binding(employee_id, attest))
                    .await
                    .map_err(|_| {
                        refusal(
                            StatusCode::UNAUTHORIZED,
                            "step_up_failed",
                            "the passkey step-up did not verify",
                        )
                    })?;
                sole_holder_cedar(&principal, employee_id, holders)?;
                let mark = VoidMark {
                    voided_by: me,
                    reason_code: &reason,
                    mode: "SOLE_HOLDER",
                };
                let voided_at = void_in_tx(tx, org_uuid, employee_id, &mark, None).await?;
                // review_required is the 예외 처리 mark, as for a
                // sole-holder 정정; the 사후 검토 item lands with BW-06/F-EXC.
                after["mode"] = json!("SOLE_HOLDER");
                after["review_required"] = json!(true);
                after["step_up_assertion_id"] = json!(assertion);
                let event = void_event(&principal, "employee.void", employee_id, after)?;
                let outcome = VoidOutcome {
                    employee_id,
                    status: "VOIDED",
                    voided_at: Some(voided_at),
                    review_required: true,
                    pending_request: None,
                };
                Ok((outcome, vec![event]))
            })
        })
        .await
    }
}
