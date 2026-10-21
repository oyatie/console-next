//! Applying an APPLIED BW-17 request inside the decision's transaction: a
//! PROFILE_CORRECTION becomes a 정정 by the deciding second person, an
//! IDENTITY_REVIEW carrying a SAME verdict becomes the merge, and an
//! EMPLOYEE_VOID becomes the void (MR-26).

use console_hr_domain::requests::ChangeRequestKind;
use console_kernel_core::{AuditAction, AuditEvent, TraceContext};
use console_platform_authz::Principal;
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;

use super::merge::apply_requested_merge_in_tx;
use super::{LedgerMeta, apply_fields_in_tx, lock_employee, normalize_value, route_or_refuse};
use crate::HrError;
use crate::requests::ChangeRequestResponse;

/// Carries out what an APPLIED request asks for. Kinds with nothing to carry
/// out (or an IDENTITY_REVIEW without a SAME verdict) just close.
pub async fn apply_requested_correction_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    request: &ChangeRequestResponse,
) -> Result<Vec<AuditEvent>, HrError> {
    match ChangeRequestKind::parse(&request.kind)? {
        ChangeRequestKind::ProfileCorrection => {
            apply_profile_correction(tx, principal, request).await
        }
        ChangeRequestKind::IdentityReview
            if request.payload.get("verdict").and_then(Value::as_str) == Some("SAME") =>
        {
            apply_requested_merge_in_tx(tx, principal, request).await
        }
        ChangeRequestKind::EmployeeVoid => {
            crate::registration_void::apply_requested_void_in_tx(tx, principal, request).await
        }
        _ => Ok(Vec::new()),
    }
}

async fn apply_profile_correction(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    request: &ChangeRequestResponse,
) -> Result<Vec<AuditEvent>, HrError> {
    let changes = request
        .payload
        .get("changes")
        .and_then(Value::as_object)
        .filter(|changes| !changes.is_empty())
        .ok_or_else(|| HrError::validation("payload.changes must name at least one field"))?;
    let mut fields = Vec::with_capacity(changes.len());
    for (field, value) in changes {
        route_or_refuse(field)?;
        fields.push((field.clone(), normalize_value(field, value)?));
    }
    let org = *principal.org_id.as_uuid();
    let head = lock_employee(tx, org, request.subject_id).await?;
    let meta = LedgerMeta {
        reason_code: &request.reason_code,
        note: request.note.as_deref(),
        corrected_by: *principal.user_id.as_uuid(),
        change_request_id: Some(request.id),
        review_required: false,
        batch_id: None,
    };
    apply_fields_in_tx(tx, org, request.subject_id, &head, &fields, &meta).await?;
    let (before, after) = super::catalog::audit_snapshots(&head, &fields);
    let applied: Vec<&String> = fields.iter().map(|(field, _)| field).collect();
    let event = AuditEvent::new(
        Some(principal.user_id),
        AuditAction::new("employee.correct").map_err(HrError::from_kernel)?,
        "employee",
        request.subject_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(principal.org_id)
    .with_snapshots(
        before,
        Some(json!({
            "classification": after,
            "applied": applied,
            "change_request_id": request.id,
            "requested_by": request.requested_by,
            "reason_code": &request.reason_code,
        })),
    );
    Ok(vec![event])
}
