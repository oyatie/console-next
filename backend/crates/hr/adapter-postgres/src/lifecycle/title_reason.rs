//! BW-13 lifecycle seams: a PROMOTE's catalog title, the 강등 check, and the
//! BW-07 reason code of a TRANSFER or PROMOTE.

use console_hr_domain::lifecycle::event::{
    EmployeeForLifecycle, NormalizedEmployeeLifecycleTransition,
};
use console_kernel_core::{KernelError, OrgId};
use console_settings_domain::code_lists::{
    ReasonDomain, TenantCode, ValidReason, is_tenant_code, validate_reason,
};
use sqlx::{PgConnection, Postgres, Row};
use uuid::Uuid;

use super::classification::check_demotion;
use crate::HrError;

/// A `KernelError` as an `HrError` that keeps its stable code
/// (`HrError::from_kernel` maps by kind only, which the wire pins rely on).
pub fn coded(error: KernelError) -> HrError {
    let code = error.code;
    let mut hr = HrError::from_kernel(error);
    if let Some(code) = code {
        hr.code = code;
    }
    hr
}

/// A PROMOTE by catalog id at record time: the title must be active, and its
/// label becomes `to_position` (so the schedule fold, the no-op rule and the
/// display text all read it). A scheduled PROMOTE already carries the label.
pub async fn fill_promote_title(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    transition: &mut NormalizedEmployeeLifecycleTransition,
) -> Result<(), HrError> {
    let (Some(id), None) = (transition.to_job_title_id, &transition.to_position) else {
        return Ok(());
    };
    let label: Option<String> = sqlx::query_scalar(
        "SELECT label FROM job_titles WHERE org_id = $1 AND id = $2 AND kind = 'TITLE' AND active",
    )
    .bind(org_uuid)
    .bind(id)
    .fetch_optional(tx.as_mut())
    .await?;
    let label = label.ok_or_else(|| {
        coded(
            KernelError::validation("to_job_title_id is not an active job title")
                .with_code("job_title_unknown")
                .with_field("to_job_title_id"),
        )
    })?;
    transition.to_position = Some(label);
    Ok(())
}

/// The catalog title the event leaves on the employee, after the 강등 check
/// on the 직급 and the 직위 (MR-25): a PROMOTE of the 직위 sets it (by id, or
/// clears it when promoted by free text); a 직급-only PROMOTE and any other
/// event keep the current one.
pub async fn promote_target_title(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    current: &EmployeeForLifecycle,
    transition: &NormalizedEmployeeLifecycleTransition,
) -> Result<Option<Uuid>, HrError> {
    if transition.event_type != "PROMOTE" {
        return Ok(current.job_title_id);
    }
    let reason = transition.reason_code.as_deref();
    let grade = (
        current.classification.grade_id,
        transition.classify.to_grade_id,
    );
    check_demotion(tx, org_uuid, grade, reason).await?;
    if transition.to_position.is_none() {
        return Ok(current.job_title_id);
    }
    let title = (current.job_title_id, transition.to_job_title_id);
    check_demotion(tx, org_uuid, title, reason).await?;
    Ok(transition.to_job_title_id)
}

/// Checks a request's reason code against its event's BW-07 domain (normalise
/// admits a code only on TRANSFER and PROMOTE); the comment is the note.
pub async fn validate_lifecycle_reason(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: OrgId,
    transition: &NormalizedEmployeeLifecycleTransition,
) -> Result<(), HrError> {
    let Some(code) = transition.reason_code.as_deref() else {
        return Ok(());
    };
    let domain = match transition.event_type.as_str() {
        "TRANSFER" => ReasonDomain::LifecycleTransfer,
        "PROMOTE" => ReasonDomain::LifecyclePromote,
        _ => {
            return Err(HrError::validation(
                "reason_code is only allowed for TRANSFER and PROMOTE",
            ));
        }
    };
    validate_reason_code(tx, org, domain, code, Some(&transition.comment))
        .await
        .map(|_| ())
}

/// A BW-07 code of `domain` (system, or the tenant's active one) with its note.
pub async fn validate_reason_code(
    tx: &mut PgConnection,
    org: OrgId,
    domain: ReasonDomain,
    code: &str,
    note: Option<&str>,
) -> Result<ValidReason, HrError> {
    // the tenant-code lookup mirrors settings-adapter's
    // validate_reason_in_tx (an adapter → adapter edge is forbidden); both
    // collapse into one call once ADR-006 moves it to platform/db.
    let mut tenant = Vec::new();
    if is_tenant_code(code) {
        let row = sqlx::query(
            "SELECT requires_note, active, involuntary, notice_required FROM reason_codes \
             WHERE org_id = $1 AND domain = $2 AND code = $3",
        )
        .bind(org.as_uuid())
        .bind(domain.as_str())
        .bind(code)
        .fetch_optional(tx.as_mut())
        .await?;
        if let Some(row) = row {
            tenant.push(TenantCode {
                code: code.to_owned(),
                requires_note: row.try_get("requires_note")?,
                active: row.try_get("active")?,
                involuntary: row.try_get("involuntary")?,
                notice_required: row.try_get("notice_required")?,
            });
        }
    }
    validate_reason(domain, code, note, &tenant).map_err(|error| coded(error.into()))
}

/// The `lifecycle_cancel` reason of a correction or rescission.
pub(super) async fn check_void_reason(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: OrgId,
    reason_code: &str,
    note: Option<&str>,
) -> Result<(), HrError> {
    if note.is_some_and(|n| n.chars().count() > 1000) {
        return Err(HrError::validation("note must be at most 1000 characters"));
    }
    validate_reason_code(
        tx,
        org,
        ReasonDomain::LifecycleCancel,
        reason_code.trim(),
        note,
    )
    .await
    .map(|_| ())
}
