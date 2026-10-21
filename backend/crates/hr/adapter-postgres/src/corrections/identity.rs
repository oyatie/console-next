//! `POST /employees/{id}/identity-resolution`: an HR person resolves an
//! identity-review record. DIFFERENT clears the flag. SAME (a merge into
//! `keep_employee_id`) needs an IDENTITY_MERGE step-up (401 without) and a
//! second person through a BW-17 IDENTITY_REVIEW request; a sole holder's
//! merge applies with the review flag.

use console_hr_domain::corrections::{HighRiskPath, IdentityVerdict};
use console_hr_domain::requests::ChangeRequestKind;
use console_kernel_core::{AuditAction, AuditEvent, TraceContext};
use console_platform_auth::{MobilePasskeyStepUpEnvelope, PasskeyService};
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::OffsetDateTime;
use uuid::Uuid;

use super::merge::{
    Resolution, lock_pair, merge_binding, require_review, resolution_event, write_resolution_in_tx,
};
use super::{SecondPersonContext, lock_employee, refusal};
use crate::authz::authorize_hr_org_wide;
use crate::requests::cedar::sole_holder_cedar;
use crate::requests::create::{NewChangeRequest, insert_change_request_in_tx};
use crate::requests::{ChangeRequestResponse, reason_code};
use crate::{HrError, HrService};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResolveIdentityRequest {
    /// `SAME` or `DIFFERENT`.
    #[serde(deserialize_with = "deserialize_enum_9")]
    pub verdict: String,
    /// SAME: the record that is kept.
    #[serde(default)]
    pub keep_employee_id: Option<Uuid>,
    pub reason_code: String,
    /// SAME: an IDENTITY_MERGE step-up bound to this employee and
    /// `merge_payload(keep_employee_id)`.
    #[serde(default)]
    pub step_up: Option<MobilePasskeyStepUpEnvelope>,
}

#[derive(Debug, Serialize)]
pub struct IdentityResolutionOutcome {
    pub employee_id: Uuid,
    pub verdict: &'static str,
    /// Set once a merge is applied.
    pub merged_into_employee_id: Option<Uuid>,
    pub review_required: bool,
    /// A SAME verdict waiting for a second person.
    pub pending_request: Option<ChangeRequestResponse>,
}

fn unauthorized(code: &'static str, message: &str) -> HrError {
    refusal(StatusCode::UNAUTHORIZED, code, message)
}

impl HrService {
    pub async fn resolve_identity(
        &self,
        principal: Principal,
        passkeys: &PasskeyService,
        employee_id: Uuid,
        body: ResolveIdentityRequest,
        holders: SecondPersonContext,
    ) -> Result<IdentityResolutionOutcome, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let verdict = IdentityVerdict::parse(body.verdict.trim())?;
        let reason = reason_code(&body.reason_code, "reason_code")?;
        let me = *principal.user_id.as_uuid();
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        if verdict == IdentityVerdict::Different {
            return with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
                Box::pin(async move {
                    require_review(&lock_employee(tx, org_uuid, employee_id).await?)?;
                    let resolution = Resolution {
                        employee_id,
                        verdict: verdict.as_str(),
                        merged_into: None,
                        reason_code: &reason,
                        resolved_by: me,
                        change_request_id: None,
                        step_up_assertion_id: None,
                        review_required: false,
                    };
                    write_resolution_in_tx(tx, org_uuid, &resolution).await?;
                    let event = resolution_event(&principal, &resolution)?;
                    Ok((
                        outcome(employee_id, verdict, None, false, None),
                        vec![event],
                    ))
                })
            })
            .await;
        }
        let keep = body
            .keep_employee_id
            .filter(|keep| *keep != employee_id)
            .ok_or_else(|| HrError::validation("a SAME verdict names another keep_employee_id"))?;
        let step_up = body.step_up.ok_or_else(|| {
            unauthorized(
                "step_up_required",
                "merging identities needs a passkey step-up",
            )
        })?;
        let path = holders.path()
            .ok_or_else(|| {
                refusal(
                    StatusCode::FORBIDDEN,
                    "identity_merge_sole_holder_refused",
                    "no second person can approve this merge and the organization refuses sole-holder merges",
                )
            })?;
        let passkeys = passkeys.clone();
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                lock_pair(tx, org_uuid, employee_id, keep).await?;
                let assertion = passkeys
                    .verify_and_record_step_up_in_tx(
                        tx,
                        step_up,
                        me,
                        &merge_binding(employee_id, keep),
                    )
                    .await
                    .map_err(|_| {
                        unauthorized("step_up_failed", "the passkey step-up did not verify")
                    })?;
                if path == HighRiskPath::SecondPerson {
                    let payload = json!({
                        "verdict": "SAME",
                        "keep_employee_id": keep,
                        "step_up_assertion_id": assertion,
                    });
                    let request = insert_change_request_in_tx(
                        tx,
                        NewChangeRequest {
                            org: org_uuid,
                            kind: ChangeRequestKind::IdentityReview,
                            subject_type: "EMPLOYEE",
                            subject_id: employee_id,
                            payload: &payload,
                            reason_code: &reason,
                            note: None,
                            requested_by: me,
                            assignee_user_id: None,
                        },
                    )
                    .await?;
                    let event = AuditEvent::new(
                        Some(principal.user_id),
                        AuditAction::new("change_request.create").map_err(HrError::from_kernel)?,
                        "change_request",
                        request.id.to_string(),
                        TraceContext::generate(),
                        OffsetDateTime::now_utc(),
                    )
                    .with_org(org)
                    .with_snapshots(
                        None,
                        Some(json!({
                            "kind": ChangeRequestKind::IdentityReview.as_str(),
                            "subject_id": employee_id,
                            "step_up_assertion_id": assertion,
                            "reason_code": &reason,
                        })),
                    );
                    return Ok((
                        outcome(employee_id, verdict, None, false, Some(request)),
                        vec![event],
                    ));
                }
                // Sole holder (decisions #7 case B): Cedar admits the
                // requester as decider only with the step-up verified above.
                sole_holder_cedar(&principal, employee_id, holders)?;
                let resolution = Resolution {
                    employee_id,
                    verdict: verdict.as_str(),
                    merged_into: Some(keep),
                    reason_code: &reason,
                    resolved_by: me,
                    change_request_id: None,
                    step_up_assertion_id: Some(assertion),
                    review_required: true,
                };
                write_resolution_in_tx(tx, org_uuid, &resolution).await?;
                let event = resolution_event(&principal, &resolution)?;
                Ok((
                    outcome(employee_id, verdict, Some(keep), true, None),
                    vec![event],
                ))
            })
        })
        .await
    }
}

fn outcome(
    employee_id: Uuid,
    verdict: IdentityVerdict,
    merged_into_employee_id: Option<Uuid>,
    review_required: bool,
    pending_request: Option<ChangeRequestResponse>,
) -> IdentityResolutionOutcome {
    IdentityResolutionOutcome {
        employee_id,
        verdict: verdict.as_str(),
        merged_into_employee_id,
        review_required,
        pending_request,
    }
}

fn deserialize_enum_9<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(deserializer, &["SAME", "DIFFERENT"])
}
