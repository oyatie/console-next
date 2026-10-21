//! BW-19 1: the override of a `duplicate_candidate` refusal is the governed
//! exception `DUPLICATE_NAME_CONFIRMED` (low risk: RECORDED at once, no second
//! person). It is requested and consumed inside the registration's own
//! transaction through the governance owner's in-tx API (ADR-004), so a
//! rolled-back registration leaves no exception behind.

use std::time::Duration;

use console_governance_adapter_postgres::PgGovernanceError;
use console_governance_adapter_postgres::exception::{
    ExceptionRequest, GovernedWrite, consume_exception_conn, request_exception_conn,
};
use console_governance_domain::exception::{
    ExceptionSettings, RuleCode, SoleHolderMode, SubjectType,
};
use console_kernel_core::{KernelError, OrgId, UserId};
use console_settings_adapter_postgres::{resolve_in_tx, validate_reason_in_tx};
use console_settings_domain::code_lists::ReasonDomain;
use console_settings_domain::{SettingKey, SettingValue};
use sqlx::Postgres;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::HrError;
use crate::directory::create_duplicates::{DuplicateOverride, override_payload};

const RULE: RuleCode = RuleCode::DuplicateNameConfirmed;

const SETTING_KEYS: [SettingKey; 3] = [
    SettingKey::ExceptionsApprovalTtlDays,
    SettingKey::AuthzSoleHolderMode,
    SettingKey::ReviewSoleHolderExceptionDue,
];

fn governance(error: PgGovernanceError) -> HrError {
    match error {
        PgGovernanceError::Db(error) => HrError::from(error),
        PgGovernanceError::Domain(error) => coded(error),
    }
}

/// A kernel refusal keeps its own code (`reason_code_invalid`, …).
fn coded(error: KernelError) -> HrError {
    let code = error.code;
    let mut hr = HrError::from_kernel(error);
    if let Some(code) = code {
        hr.code = code;
    }
    hr
}

/// The registry values the exception is admitted under (D0.3 snapshot).
async fn exception_settings(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: OrgId,
) -> Result<ExceptionSettings, HrError> {
    let settings = resolve_in_tx(
        tx.as_mut(),
        org,
        &SETTING_KEYS,
        None,
        OffsetDateTime::now_utc(),
    )
    .await
    .map_err(coded)?;
    let value = |key: SettingKey| match settings.get(&key) {
        Some(Ok(resolved)) => Ok(resolved.value),
        _ => Err(HrError::internal(format!(
            "setting {} did not resolve",
            key.as_str()
        ))),
    };
    let days = |key: SettingKey| match value(key)? {
        SettingValue::Int(days) => u64::try_from(days)
            .map_err(|_| HrError::internal(format!("setting {} is out of range", key.as_str()))),
        _ => Err(HrError::internal(format!(
            "setting {} is not a number",
            key.as_str()
        ))),
    };
    Ok(ExceptionSettings {
        approval_ttl_days: u16::try_from(days(SettingKey::ExceptionsApprovalTtlDays)?)
            .map_err(|_| HrError::internal("exceptions.approval_ttl_days is out of range"))?,
        sole_holder_mode: match value(SettingKey::AuthzSoleHolderMode)? {
            SettingValue::Code("step_up_notice_review") => SoleHolderMode::StepUpNoticeReview,
            // Fail closed: any other value refuses the fallback.
            _ => SoleHolderMode::Refuse,
        },
        sole_holder_review_due: Duration::from_secs(
            days(SettingKey::ReviewSoleHolderExceptionDue)? * 86_400,
        ),
    })
}

/// Validates the override's reason (BW-07 domain `exception`), records the
/// exception about the new employee and consumes it with this registration.
/// Returns the exception id.
///
/// # Errors
/// 422 `reason_code_invalid` / `reason_note_required`; the governance owner's
/// refusals verbatim.
pub async fn record_duplicate_exception(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    employee_id: Uuid,
    given: &DuplicateOverride,
) -> Result<Uuid, HrError> {
    let reason = validate_reason_in_tx(
        tx.as_mut(),
        org,
        ReasonDomain::Exception,
        given.reason_code.trim(),
        given.note.as_deref(),
    )
    .await
    .map_err(coded)?;
    let settings = exception_settings(tx, org).await?;
    let payload = override_payload(employee_id, given);
    let requested = request_exception_conn(
        tx.as_mut(),
        &ExceptionRequest {
            rule: RULE,
            subject_type: SubjectType::Employee,
            subject_id: employee_id,
            reason_code: &reason.code,
            note: reason.note.as_deref(),
            payload: &payload,
            affected_periods: &[],
            requested_by: actor,
            step_up_assertion_id: None,
            other_eligible_holders: 0,
        },
        &settings,
    )
    .await
    .map_err(governance)?;
    consume_exception_conn(
        tx.as_mut(),
        requested.id,
        &GovernedWrite {
            rule: RULE,
            subject_type: SubjectType::Employee,
            subject_id: employee_id,
            payload: &payload,
            affected_periods: &[],
        },
    )
    .await
    .map_err(governance)?;
    Ok(requested.id)
}
