//! The void writes, shared by the SETUP delete, a governed void and a void a
//! second person applies: withdraw what the registration scheduled and
//! placed, mark the record VOIDED, and (SETUP) destroy its personal data.

use console_hr_domain::registration_void::{VoidFacts, void_basis};
use console_kernel_core::{AuditAction, AuditEvent, TraceContext, UserId};
use console_ontology_canonical_adapter_postgres::employee_void::{
    VoidMark, destroy_voided_pii_in_tx, void_employee_head_in_tx,
};
use console_platform_authz::Principal;
use console_settings_domain::SettingKey;
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use time::{OffsetDateTime, UtcOffset};
use uuid::Uuid;

use super::facts::{int_setting, lock};
use crate::HrError;
use crate::lifecycle::record::cancel_scheduled_lifecycle_event_tx;
use crate::lifecycle::title_reason::coded;
use crate::requests::ChangeRequestResponse;

const CANCEL_REASON: &str = "등록 취소 (registration voided)";

/// Cancels every SCHEDULED 발령 (a PRE_HIRE's ONBOARD, so the runner never
/// brings the person back on the hire date), supersedes the 법인 · 사업장
/// assignment, then marks the record. `destroy` tombstones it in the same
/// transaction; `Some(true)` also frees the 사번 (SETUP only).
pub(crate) async fn void_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee_id: Uuid,
    mark: &VoidMark<'_>,
    destroy: Option<bool>,
) -> Result<OffsetDateTime, HrError> {
    let scheduled: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM employee_lifecycle_events \
         WHERE org_id = $1 AND employee_id = $2 AND state = 'SCHEDULED' ORDER BY effective_date",
    )
    .bind(org)
    .bind(employee_id)
    .fetch_all(tx.as_mut())
    .await?;
    for event in scheduled {
        cancel_scheduled_lifecycle_event_tx(
            tx,
            org,
            event,
            UserId::from_uuid(mark.voided_by),
            CANCEL_REASON,
        )
        .await?;
    }
    console_entity_adapter_postgres::employment_hire::withdraw_voided_in_tx(
        tx.as_mut(),
        org,
        employee_id,
    )
    .await
    .map_err(coded)?;
    let events: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM employee_lifecycle_events WHERE org_id=$1 AND employee_id=$2",
    )
    .bind(org)
    .bind(employee_id)
    .fetch_all(tx.as_mut())
    .await?;
    for event in events {
        crate::cases::open::cancel(tx, org, event, CANCEL_REASON).await?;
    }
    let voided_at = void_employee_head_in_tx(tx, org, employee_id, mark).await?;
    if let Some(release_number) = destroy {
        destroy_voided_pii_in_tx(tx, employee_id, release_number).await?;
    }
    Ok(voided_at)
}

/// The audit row of a void: ids, 사번, reason and basis; no other PII.
pub(crate) fn void_event(
    principal: &Principal,
    action: &str,
    employee_id: Uuid,
    after: Value,
) -> Result<AuditEvent, HrError> {
    Ok(AuditEvent::new(
        Some(principal.user_id),
        AuditAction::new(action).map_err(HrError::from_kernel)?,
        "employee",
        employee_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(principal.org_id)
    .with_snapshots(None, Some(after)))
}

/// The second person applies an EMPLOYEE_VOID. Every condition is checked
/// again on the locked record; the window is measured at the filing date, so
/// a slow decision cannot age the request out (or in).
///
/// # Errors
/// The void refusals (409), 404 when the record is gone.
pub async fn apply_requested_void_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    request: &ChangeRequestResponse,
) -> Result<Vec<AuditEvent>, HrError> {
    let org = *principal.org_id.as_uuid();
    let attest = request
        .payload
        .get("attest_never_worked")
        .and_then(Value::as_bool)
        .ok_or_else(|| HrError::validation("payload.attest_never_worked must be a boolean"))?;
    let locked = lock(tx, org, request.subject_id).await?;
    let window = int_setting(tx, org, SettingKey::PeopleVoidWindow).await?;
    let filed_on = request
        .created_at
        .to_offset(UtcOffset::from_hms(9, 0, 0).map_err(|_| HrError::internal("KST offset"))?)
        .date();
    let basis = void_basis(
        VoidFacts {
            employment_status: &locked.status,
            registered_on: locked.registered_on,
            has_work_records: locked.has_work_records,
        },
        filed_on,
        window,
        attest,
    )
    .map_err(coded)?;
    let mark = VoidMark {
        voided_by: *principal.user_id.as_uuid(),
        reason_code: &request.reason_code,
        mode: "GOVERNED",
    };
    void_in_tx(tx, org, request.subject_id, &mark, None).await?;
    Ok(vec![void_event(
        principal,
        "employee.void",
        request.subject_id,
        json!({
            "employee_number": locked.employee_number,
            "basis": basis.as_str(),
            "mode": "GOVERNED",
            "change_request_id": request.id,
            "requested_by": request.requested_by,
            "reason_code": &request.reason_code,
        }),
    )?])
}
