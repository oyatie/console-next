//! The SAME (merge) verdict: the IDENTITY_MERGE step-up binding, the merge
//! write, and applying a merge a second person approved.

use console_kernel_core::{AuditAction, AuditEvent, TraceContext};
use console_ontology_canonical_adapter_postgres::employee_correction::clear_identity_review_in_tx;
use console_platform_auth::{MobilePasskeyStepUpBinding, MobileStepUpActionKind};
use console_platform_authz::Principal;
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use super::{LockedEmployee, lock_employee, refusal};
use crate::HrError;
use crate::digest::sha256_hex;
use crate::requests::ChangeRequestResponse;

/// The canonical payload an IDENTITY_MERGE step-up signs: keys sorted, no
/// whitespace. Its SHA-256 hex is the binding's `payload_hash`.
#[must_use]
pub fn merge_payload(keep_employee_id: Uuid) -> String {
    format!(r#"{{"keep_employee_id":"{keep_employee_id}","verdict":"SAME"}}"#)
}

/// The step-up binding a SAME verdict on `employee_id` must carry.
#[must_use]
pub fn merge_binding(employee_id: Uuid, keep_employee_id: Uuid) -> MobilePasskeyStepUpBinding {
    let kind = MobileStepUpActionKind::IdentityMerge;
    MobilePasskeyStepUpBinding {
        action_kind: kind,
        object_id: employee_id,
        reason_key: kind.expected_reason_key().to_owned(),
        replay_attempt: None,
        payload_hash: Some(sha256_hex(merge_payload(keep_employee_id).as_bytes())),
    }
}

/// Locks the merged record and the kept one in id order (no deadlock between
/// two opposite merges). The merged record must still be under review.
pub(crate) async fn lock_pair(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee_id: Uuid,
    keep_employee_id: Uuid,
) -> Result<LockedEmployee, HrError> {
    let (first, second) = if employee_id < keep_employee_id {
        (employee_id, keep_employee_id)
    } else {
        (keep_employee_id, employee_id)
    };
    let first_row = lock_employee(tx, org, first).await?;
    let second_row = lock_employee(tx, org, second).await?;
    let subject = if first == employee_id {
        first_row
    } else {
        second_row
    };
    require_review(&subject)?;
    Ok(subject)
}

pub(crate) fn require_review(subject: &LockedEmployee) -> Result<(), HrError> {
    if subject.identity_review_required {
        Ok(())
    } else {
        Err(refusal(
            StatusCode::CONFLICT,
            "identity_review_not_required",
            "this employee record is not under identity review",
        ))
    }
}

/// One identity-resolution row and the cleared review flag.
pub(crate) struct Resolution<'a> {
    pub employee_id: Uuid,
    pub verdict: &'a str,
    pub merged_into: Option<Uuid>,
    pub reason_code: &'a str,
    pub resolved_by: Uuid,
    pub change_request_id: Option<Uuid>,
    pub step_up_assertion_id: Option<Uuid>,
    pub review_required: bool,
}

pub(crate) async fn write_resolution_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    resolution: &Resolution<'_>,
) -> Result<(), HrError> {
    sqlx::query(
        "INSERT INTO employee_identity_resolutions (org_id, employee_id, verdict, \
         merged_into_employee_id, reason_code, resolved_by, change_request_id, \
         step_up_assertion_id, review_required) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(org)
    .bind(resolution.employee_id)
    .bind(resolution.verdict)
    .bind(resolution.merged_into)
    .bind(resolution.reason_code)
    .bind(resolution.resolved_by)
    .bind(resolution.change_request_id)
    .bind(resolution.step_up_assertion_id)
    .bind(resolution.review_required)
    .execute(tx.as_mut())
    .await?;
    clear_identity_review_in_tx(tx, org, resolution.employee_id).await?;
    Ok(())
}

pub(crate) fn resolution_event(
    principal: &Principal,
    resolution: &Resolution<'_>,
) -> Result<AuditEvent, HrError> {
    Ok(AuditEvent::new(
        Some(principal.user_id),
        AuditAction::new("employee.identity_resolve").map_err(HrError::from_kernel)?,
        "employee",
        resolution.employee_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(principal.org_id)
    .with_snapshots(
        Some(json!({ "identity_review_required": true })),
        Some(json!({
            "verdict": resolution.verdict,
            "merged_into_employee_id": resolution.merged_into,
            "change_request_id": resolution.change_request_id,
            "step_up_assertion_id": resolution.step_up_assertion_id,
            "review_required": resolution.review_required,
            "reason_code": resolution.reason_code,
        })),
    ))
}

fn payload_uuid(payload: &Value, key: &str) -> Result<Uuid, HrError> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .and_then(|raw| Uuid::parse_str(raw).ok())
        .ok_or_else(|| HrError::validation(format!("payload.{key} must be a UUID")))
}

/// The second person applies a SAME verdict. The requester's IDENTITY_MERGE
/// step-up must exist for exactly this merge, so a hand-filed request cannot
/// skip it (fail closed).
pub(crate) async fn apply_requested_merge_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    request: &ChangeRequestResponse,
) -> Result<Vec<AuditEvent>, HrError> {
    let keep = payload_uuid(&request.payload, "keep_employee_id")?;
    let step_up = payload_uuid(&request.payload, "step_up_assertion_id")?;
    let org = *principal.org_id.as_uuid();
    let binding = merge_binding(request.subject_id, keep);
    let verified: Option<Uuid> = sqlx::query_scalar(
        "SELECT ceremony_id FROM step_up_assertions WHERE org_id = $1 AND ceremony_id = $2 \
         AND user_id = $3 AND action_kind = $4 AND object_id = $5 AND payload_hash = $6",
    )
    .bind(org)
    .bind(step_up)
    .bind(request.requested_by)
    .bind(binding.action_kind.as_wire())
    .bind(request.subject_id)
    .bind(binding.payload_hash.as_deref())
    .fetch_optional(tx.as_mut())
    .await?;
    if verified.is_none() {
        return Err(refusal(
            StatusCode::CONFLICT,
            "identity_merge_step_up_missing",
            "the requester's identity-merge step-up was not found for this merge",
        ));
    }
    lock_pair(tx, org, request.subject_id, keep).await?;
    let resolution = Resolution {
        employee_id: request.subject_id,
        verdict: "SAME",
        merged_into: Some(keep),
        reason_code: &request.reason_code,
        resolved_by: *principal.user_id.as_uuid(),
        change_request_id: Some(request.id),
        step_up_assertion_id: Some(step_up),
        review_required: false,
    };
    write_resolution_in_tx(tx, org, &resolution).await?;
    Ok(vec![resolution_event(principal, &resolution)?])
}
