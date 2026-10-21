//! `PATCH /employees/{id}`: an HR person corrects master data (정정). Low-risk
//! fields apply at once; a high-risk field goes to a second person through a
//! BW-17 request, or, for a sole holder, applies after a step-up bound to the
//! payload, with the review flag (decisions #7 case B; 401 without).

use console_hr_domain::corrections::{CorrectionRoute, HighRiskPath, route_for_current};
use console_hr_domain::requests::ChangeRequestKind;
use console_kernel_core::{AuditAction, AuditEvent, KernelError, TraceContext, UserId};
use console_platform_auth::{MobilePasskeyStepUpBinding, MobileStepUpActionKind, PasskeyService};
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use http::StatusCode;
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

use super::{
    CorrectEmployeeRequest, CorrectionOutcome, FieldValue, LedgerMeta, LockedEmployee,
    SecondPersonContext, apply_fields_in_tx, check_against_record, lock_employee, normalize_value,
    refusal, route_or_refuse,
};
use crate::authz::{authorize_hr_person, hr_reach};
use crate::digest::sha256_hex;
use crate::own_record::own_record_guard;
use crate::requests::cedar::sole_holder_cedar;
use crate::requests::create::{NewChangeRequest, insert_change_request_in_tx};
use crate::requests::{note, reason_code};
use crate::{HrError, HrService};

/// Every changed field, normalized, with its route before the record is read.
type Checked = Vec<(FieldValue, CorrectionRoute)>;

fn check_changes(changes: &Map<String, Value>) -> Result<Checked, HrError> {
    if changes.is_empty() {
        return Err(HrError::validation("changes must name at least one field"));
    }
    changes
        .iter()
        .map(|(field, value)| {
            // Route first: a field that cannot be corrected is 409, not a shape error.
            let route = route_or_refuse(field)?;
            Ok(((field.clone(), normalize_value(field, value)?), route))
        })
        .collect()
}

/// Low-risk and high-risk pairs once the record is known: a field recorded
/// for the first time is low-risk (`route_for_current`).
fn split(checked: Checked, head: &LockedEmployee) -> (Vec<FieldValue>, Vec<FieldValue>) {
    let (mut low, mut high) = (Vec::new(), Vec::new());
    for (pair, route) in checked {
        let recorded = head.current(&pair.0).is_some();
        match route_for_current(route, recorded) {
            CorrectionRoute::Low => low.push(pair),
            _ => high.push(pair),
        }
    }
    (low, high)
}

/// The canonical payload a sole holder's step-up signs: `changes` as sent,
/// keys sorted, no whitespace. Its SHA-256 hex is the binding's `payload_hash`.
#[must_use]
pub fn correction_payload(changes: &Map<String, Value>) -> String {
    Value::Object(changes.clone()).to_string()
}

/// The step-up binding of a sole holder's correction of `employee_id`. No
/// correction kind exists in the F-CEDAR step-up enum; the sole-holder self
/// decision is the governed exception of decisions #7 case B, so it signs as
/// EXCEPTION_DECIDE, bound to this employee and payload (no cross-use).
// no correction kind in the F-CEDAR step-up enum (one migration,
// F-CEDAR-owned); add CORRECTION_SOLE_HOLDER there when it reopens the enum.
#[must_use]
pub fn correction_binding(
    employee_id: Uuid,
    changes: &Map<String, Value>,
) -> MobilePasskeyStepUpBinding {
    let kind = MobileStepUpActionKind::ExceptionDecide;
    MobilePasskeyStepUpBinding {
        action_kind: kind,
        object_id: employee_id,
        reason_key: kind.expected_reason_key().to_owned(),
        replay_attempt: None,
        payload_hash: Some(sha256_hex(correction_payload(changes).as_bytes())),
    }
}

fn unauthorized(code: &'static str, message: &str) -> HrError {
    refusal(StatusCode::UNAUTHORIZED, code, message)
}

impl HrService {
    pub async fn correct_employee(
        &self,
        principal: Principal,
        passkeys: &PasskeyService,
        employee_id: Uuid,
        body: CorrectEmployeeRequest,
        holders: SecondPersonContext,
    ) -> Result<CorrectionOutcome, HrError> {
        hr_reach(&principal, Feature::EmployeeDirectoryManage)?;
        let expected = OffsetDateTime::parse(
            body.expected_updated_at.trim(),
            &time::format_description::well_known::Rfc3339,
        )
        .map_err(|_| HrError::validation("expected_updated_at must be an RFC 3339 timestamp"))?;
        let checked = check_changes(&body.changes)?;
        let changes = body.changes;
        let envelope = body.step_up;
        let passkeys = passkeys.clone();
        let reason = reason_code(&body.reason_code, "reason_code")?;
        let note = note(body.note.as_deref())?;
        let me = *principal.user_id.as_uuid();
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                authorize_hr_person(tx, &principal, Feature::EmployeeDirectoryManage, employee_id).await?;
                let head = lock_employee(tx, org_uuid, employee_id).await?;
                let actor = UserId::from_uuid(me);
                own_record_guard(tx, org, actor, employee_id, Feature::EmployeeDirectoryManage).await?;
                if head.updated_at != expected {
                    return Err(HrError::from_kernel(KernelError::conflict(
                        "employee changed since it was read; reload before correcting",
                    )));
                }
                let (low, high) = split(checked, &head);
                let sole = if high.is_empty() {
                    false
                } else {
                    let path = holders.path().ok_or_else(|| {
                        refusal(
                            StatusCode::FORBIDDEN,
                            "employee_correction_sole_holder_refused",
                            "no second person can approve this correction and the organization refuses sole-holder corrections",
                        )
                    })?;
                    path == HighRiskPath::SoleHolderReview
                };
                let mut assertion = None;
                if sole {
                    let envelope = envelope.ok_or_else(|| {
                        unauthorized(
                            "step_up_required",
                            "a sole holder's correction of this field needs a passkey step-up",
                        )
                    })?;
                    let binding = correction_binding(employee_id, &changes);
                    let verified = passkeys
                        .verify_and_record_step_up_in_tx(tx, envelope, me, &binding)
                        .await
                        .map_err(|_| {
                            unauthorized("step_up_failed", "the passkey step-up did not verify")
                        })?;
                    sole_holder_cedar(&principal, employee_id, holders)?;
                    // review_required is the only 예외 처리 mark;
                    // the governed-exception row and 사후 검토 item land with
                    // BW-06/F-EXC (decisions #7 case B).
                    assertion = Some(verified);
                }
                let mut now: Vec<FieldValue> = low;
                let mut pending_request = None;
                if sole {
                    now.extend(high.iter().cloned());
                } else if !high.is_empty() {
                    // Filed only with values the second person can apply.
                    check_against_record(tx, org_uuid, employee_id, &head, &high).await?;
                    let changes: Map<String, Value> =
                        high.iter().map(|(field, value)| (field.clone(), json!(value))).collect();
                    pending_request = Some(
                        insert_change_request_in_tx(
                            tx,
                            NewChangeRequest {
                                org: org_uuid,
                                kind: ChangeRequestKind::ProfileCorrection,
                                subject_type: "EMPLOYEE",
                                subject_id: employee_id,
                                payload: &json!({ "changes": changes }),
                                reason_code: &reason,
                                note: note.as_deref(),
                                requested_by: me,
                                assignee_user_id: None,
                            },
                        )
                        .await?,
                    );
                }
                let updated_at = if now.is_empty() {
                    head.updated_at
                } else {
                    let meta = LedgerMeta {
                        import_run_id: None,
                        reason_code: &reason,
                        note: note.as_deref(),
                        corrected_by: me,
                        change_request_id: None,
                        review_required: sole,
                        batch_id: None,
                    };
                    apply_fields_in_tx(tx, org_uuid, employee_id, &head, &now, &meta).await?
                };
                let (before, after) = super::catalog::audit_snapshots(&head, &now);
                let applied: Vec<String> = now.into_iter().map(|(field, _)| field).collect();
                // Field names only: the values stay in the ledger rows.
                let event = AuditEvent::new(
                    Some(principal.user_id),
                    AuditAction::new("employee.correct").map_err(HrError::from_kernel)?,
                    "employee",
                    employee_id.to_string(),
                    TraceContext::generate(),
                    OffsetDateTime::now_utc(),
                )
                .with_org(org)
                .with_snapshots(
                    before,
                    Some(json!({
                        "classification": after,
                        "applied": &applied,
                        "pending": high.iter().filter(|_| !sole).map(|(field, _)| field).collect::<Vec<_>>(),
                        "review_required": sole,
                        "step_up_assertion_id": assertion,
                        "reason_code": &reason,
                    })),
                );
                let outcome = CorrectionOutcome {
                    employee_id,
                    updated_at,
                    applied,
                    review_required: sole,
                    pending_request,
                };
                Ok((outcome, vec![event]))
            })
        })
        .await
    }
}
