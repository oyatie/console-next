//! Decisions #7 case B on a period unlock (#8b): with no other eligible holder
//! and `authz.sole_holder.mode = step_up_notice_review`, the holder unlocks at
//! once, no delay. Beside the step-up bound to the payload hash and the lock
//! row's review flag, the unlock records a governed exception (예외 처리,
//! `PERIOD_UNLOCK_SOLE_HOLDER`, SOLE_HOLDER fallback) whose `review_due_at`
//! (`review.sole_holder_exception.due`) is the 사후 검토 item, and consumes it
//! with this write in the same transaction (the ORG-SOLE pattern).
//!
//! the notice to every other EXECUTIVE and SUPER_ADMIN waits for
//! MAIL's NOTIFY port; the exception row and the audit are the record.

use std::time::Duration;

use console_governance_adapter_postgres::PgGovernanceError;
use console_governance_adapter_postgres::exception::{
    ExceptionRequest, GovernedWrite, consume_exception_conn, request_exception_conn,
};
use console_governance_domain::exception::{
    ExceptionSettings, RuleCode, SoleHolderMode, SubjectType,
};
use console_kernel_core::UserId;
use console_settings_adapter_postgres::ResolvedSettings;
use console_settings_domain::SettingKey;
use serde_json::json;
use time::OffsetDateTime;
use uuid::Uuid;

use super::LifecycleError;
use super::period_unlock::{int_setting, internal};

const RULE: RuleCode = RuleCode::PeriodUnlockSoleHolder;

/// The recorded exception: its id and the 사후 검토 due time.
pub(super) struct SoleHolderException {
    pub(super) id: Uuid,
    pub(super) review_due_at: Option<OffsetDateTime>,
}

/// What the sole holder unlocked.
pub(super) struct SoleHolderUnlock<'a> {
    pub(super) unlocked: Uuid,
    pub(super) actor: Uuid,
    pub(super) reason_code: &'a str,
    pub(super) note: Option<&'a str>,
    pub(super) relock_at: &'a str,
    pub(super) step_up: Uuid,
}

/// Record the 예외 처리 for `unlock` and consume it with the unlock write.
pub(super) async fn record_sole_holder_exception(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    unlock: &SoleHolderUnlock<'_>,
    settings: &ResolvedSettings,
) -> Result<SoleHolderException, LifecycleError> {
    let payload = json!({
        "lockId": unlock.unlocked,
        "reasonCode": unlock.reason_code,
        "relockAt": unlock.relock_at,
    });
    let exception = request_exception_conn(
        tx.as_mut(),
        &ExceptionRequest {
            rule: RULE,
            subject_type: SubjectType::PeriodLock,
            subject_id: unlock.unlocked,
            reason_code: unlock.reason_code,
            note: unlock.note,
            payload: &payload,
            affected_periods: &[],
            requested_by: UserId::from_uuid(unlock.actor),
            step_up_assertion_id: Some(unlock.step_up),
            other_eligible_holders: 0,
        },
        &exception_settings(settings)?,
    )
    .await
    .map_err(governance)?;
    consume_exception_conn(
        tx.as_mut(),
        exception.id,
        &GovernedWrite {
            rule: RULE,
            subject_type: SubjectType::PeriodLock,
            subject_id: unlock.unlocked,
            payload: &payload,
            affected_periods: &[],
        },
    )
    .await
    .map_err(governance)?;
    Ok(SoleHolderException {
        id: exception.id,
        review_due_at: exception.admission.review_due_at,
    })
}

/// Only reached in `step_up_notice_review` mode (the handler refuses before
/// the step-up otherwise), so the mode is that one.
fn exception_settings(settings: &ResolvedSettings) -> Result<ExceptionSettings, LifecycleError> {
    let ttl = int_setting(settings, SettingKey::ExceptionsApprovalTtlDays)?;
    let due = int_setting(settings, SettingKey::ReviewSoleHolderExceptionDue)?;
    Ok(ExceptionSettings {
        approval_ttl_days: u16::try_from(ttl)
            .map_err(|_| internal("exceptions.approval_ttl_days is out of range"))?,
        sole_holder_mode: SoleHolderMode::StepUpNoticeReview,
        sole_holder_review_due: Duration::from_secs(
            u64::try_from(due)
                .map_err(|_| internal("review.sole_holder_exception.due is out of range"))?
                * 86_400,
        ),
    })
}

fn governance(error: PgGovernanceError) -> LifecycleError {
    match error {
        PgGovernanceError::Db(db) => db.into(),
        PgGovernanceError::Domain(kernel) => LifecycleError::from_kernel(kernel),
    }
}
