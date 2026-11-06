//! Decisions #7 case B on a period unlock (#8b): with no other eligible holder
//! and `authz.sole_holder.mode = step_up_notice_review`, the holder unlocks at
//! once, no delay. Beside the step-up bound to the payload hash and the lock
//! row's review flag, the unlock records a governed exception (예외 처리,
//! `PERIOD_UNLOCK_SOLE_HOLDER`, SOLE_HOLDER fallback) whose `review_due_at`
//! (`review.sole_holder_exception.due`) is the 사후 검토 item, and consumes it
//! with this write in the same transaction (the ORG-SOLE pattern).
//!
//! Current close authorities receive an in-app notice in the same transaction.

use std::time::Duration;

use console_governance_adapter_postgres::PgGovernanceError;
use console_governance_adapter_postgres::exception::{
    ExceptionRequest, GovernedWrite, consume_exception_conn, request_exception_conn,
};
use console_governance_domain::exception::{
    ExceptionSettings, RuleCode, SoleHolderMode, SubjectType,
};
use console_identity_adapter_postgres::second_person::{HolderCapability, PgHolderResolver};
use console_kernel_core::{OrgId, UserId};
use console_platform_authz::Feature;
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
    pub(super) org: OrgId,
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
    notify_holders(tx, unlock, exception.id).await?;
    Ok(SoleHolderException {
        id: exception.id,
        review_due_at: exception.admission.review_due_at,
    })
}

async fn notify_holders(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    unlock: &SoleHolderUnlock<'_>,
    exception: Uuid,
) -> Result<(), LifecycleError> {
    // Notice current holders, including those whose grants are not yet aged for approval.
    let mut recipients = PgHolderResolver {
        tx,
        org: unlock.org,
        capability: HolderCapability::Feature {
            feature: Feature::PeriodLockManage,
            branch: None,
        },
        exclude_account: None,
        exclude_employee: None,
        include_ops: true,
        now: OffsetDateTime::now_utc(),
    }
    .resolve_at_most(usize::MAX)
    .await
    .map_err(LifecycleError::from_kernel)?;
    recipients.insert(unlock.actor);
    sqlx::query(
        "INSERT INTO notifications (org_id, recipient_user_id, category, body, link, dedup_key) \
         SELECT $1, recipient, 'period_lock.sole_holder', $3, $4, $5 \
         FROM unnest($2::uuid[]) recipient ON CONFLICT DO NOTHING",
    )
    .bind(unlock.org.as_uuid())
    .bind(recipients.into_iter().collect::<Vec<_>>())
    .bind("다른 마감 권한자가 없어 기간 잠금을 단독 해제했습니다. 예외 처리와 사후 검토 기한을 확인해 주십시오.")
    .bind(json!({"type": "screen", "screen": "people/period-locks"}))
    .bind(format!("period_lock.sole_holder:{exception}"))
    .execute(tx.as_mut())
    .await?;
    Ok(())
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
