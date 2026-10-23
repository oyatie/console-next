//! BW-15 period unlock (decisions #8b, D0.1/D0.2, #7).
//!
//! `POST /period-locks/{lockId}/unlock { reasonCode, note?, relockAt, stepUp }`
//! needs a PERIOD_UNLOCK step-up and a configured time box. Another eligible
//! holder opens a request (202), then approves it with their own passkey.
//! Only the sole bound administrator during setup may use the configured
//! `step_up_notice_review` exception; go-live switches that solo path off.
//! The exception flags the lock and creates its due review item.
//!
//! Step-up payloads (lowercase hex SHA-256 of the UTF-8 text, `\n`-joined):
//! - unlock: `PERIOD_UNLOCK\n{lockId}\n{reasonCode}\n{relockAt as sent}`, object `lockId`;
//! - approve: `PERIOD_UNLOCK_APPROVE\n{requestId}`, object `requestId`.
//!
//! Both the waiting/solo decision and who may approve are Cedar decisions.

use axum::http::StatusCode;
use console_identity_adapter_postgres::second_person::{
    SecondPersonFact, SecondPersonQuery, second_person_fact_in_tx,
};
use console_kernel_core::{AuditAction, AuditEvent, KernelError, OrgId, TraceContext, UserId};
use console_platform_auth::{
    AuthError, MobilePasskeyStepUpBinding, MobilePasskeyStepUpEnvelope,
    MobilePasskeyStepUpVerificationError, MobileStepUpActionKind, PasskeyService,
};
use console_platform_authz::Feature;
use console_platform_db::period_lock::UnlockRequest;
use console_settings_adapter_postgres::ResolvedSettings;
use console_settings_domain::{SettingKey, SettingValue};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use super::LifecycleError;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UnlockPeriodLockRequest {
    pub(super) reason_code: String,
    #[serde(default)]
    pub(super) note: Option<String>,
    pub(super) relock_at: String,
    #[serde(default)]
    pub(super) step_up: Option<MobilePasskeyStepUpEnvelope>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ApprovePeriodUnlockRequest {
    /// The request the approver reviewed: a newer one refuses with 409.
    #[serde(default)]
    pub(super) request_id: Option<Uuid>,
    #[serde(default)]
    pub(super) step_up: Option<MobilePasskeyStepUpEnvelope>,
}

/// The canonical step-up payload of an unlock request.
pub(super) fn unlock_payload(lock_id: Uuid, reason_code: &str, relock_at: &str) -> String {
    format!("PERIOD_UNLOCK\n{lock_id}\n{reason_code}\n{relock_at}")
}

/// The canonical step-up payload of a second person's approval.
pub(super) fn approve_payload(request_id: Uuid) -> String {
    format!("PERIOD_UNLOCK_APPROVE\n{request_id}")
}

pub(super) fn binding(object_id: Uuid, payload: &str) -> MobilePasskeyStepUpBinding {
    let hash = hex::encode(Sha256::digest(payload.as_bytes()));
    MobilePasskeyStepUpBinding::bound(MobileStepUpActionKind::PeriodUnlock, object_id, hash)
}

/// How an unlock request proceeds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum UnlockPath {
    /// Another eligible holder exists: wait for them.
    SecondPerson,
    /// Sole holder, mode `step_up_notice_review`: unlock now, flag for review.
    SoleHolderReview,
    /// Sole holder, any other mode: refuse (fail closed).
    Refused,
}

pub(super) fn unlock_path(
    user: &str,
    org: &str,
    other_eligible_holders: i64,
    sole_holder_refuse: bool,
    setup_single_admin: bool,
    step_up: bool,
) -> UnlockPath {
    use console_platform_authz::cedar_pbac::actions::period_unlock::{Intent, UnlockFacts, decide};
    let f = UnlockFacts {
        actor_is_requester: true,
        other_eligible_holders,
        step_up,
        sole_holder_allowed: !sole_holder_refuse,
        setup_single_admin,
        intent: Intent::Wait,
    };
    if decide(user, org, org, f) {
        UnlockPath::SecondPerson
    } else if decide(
        user,
        org,
        org,
        UnlockFacts {
            intent: Intent::Unlock,
            ..f
        },
    ) {
        UnlockPath::SoleHolderReview
    } else {
        UnlockPath::Refused
    }
}

/// Admission refuses an unavailable solo path without consuming a ceremony.
pub(super) fn unlock_admitted(
    user: &str,
    org: &str,
    other_eligible_holders: i64,
    sole_holder_refuse: bool,
    setup_single_admin: bool,
) -> bool {
    use console_platform_authz::cedar_pbac::actions::period_unlock::{Intent, UnlockFacts, decide};
    decide(
        user,
        org,
        org,
        UnlockFacts {
            actor_is_requester: true,
            other_eligible_holders,
            step_up: false,
            sole_holder_allowed: !sole_holder_refuse,
            setup_single_admin,
            intent: Intent::Request,
        },
    )
}

/// A request's state as the lock list shows it: decided, or still open and
/// either waiting or past its window (expiry is read, never written).
pub(super) fn request_status(
    outcome: Option<&str>,
    relock_at: OffsetDateTime,
    now: OffsetDateTime,
) -> &'static str {
    match outcome {
        Some("APPROVED") => "APPROVED",
        Some("REJECTED") => "REJECTED",
        Some(_) => "SUPERSEDED",
        None if relock_at <= now => "EXPIRED",
        None => "PENDING",
    }
}

pub(super) fn int_setting(
    settings: &ResolvedSettings,
    key: SettingKey,
) -> Result<i64, LifecycleError> {
    match settings.get(&key) {
        Some(Ok(resolved)) => match resolved.value {
            SettingValue::Int(value) => Ok(value),
            _ => Err(internal(format!(
                "setting {} is not an integer",
                key.as_str()
            ))),
        },
        _ => Err(internal(format!(
            "setting {} did not resolve",
            key.as_str()
        ))),
    }
}

/// The D0.2 fact for an unlock requested by `requester` at `requested_at`.
pub(super) async fn second_person(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: OrgId,
    requester: Uuid,
    requested_at: OffsetDateTime,
    settings: &ResolvedSettings,
) -> Result<SecondPersonFact, LifecycleError> {
    let min_grant_age_days = i32::try_from(int_setting(
        settings,
        SettingKey::AuthzSecondPersonMinGrantAge,
    )?)
    .map_err(|_| internal("authz.second_person.min_grant_age is out of range"))?;
    Ok(second_person_fact_in_tx(
        tx,
        &SecondPersonQuery {
            org,
            feature: Feature::PeriodLockManage,
            branch: None,
            requester: UserId::from_uuid(requester),
            excluded: Vec::new(),
            case_created_at: requested_at,
            min_grant_age_days,
        },
    )
    .await?)
}

pub(super) const SETTING_KEYS: [SettingKey; 5] = [
    SettingKey::PeriodLockUnlockMaxDays,
    SettingKey::AuthzSecondPersonMinGrantAge,
    SettingKey::AuthzSoleHolderMode,
    SettingKey::ExceptionsApprovalTtlDays,
    SettingKey::ReviewSoleHolderExceptionDue,
];

/// Verify the step-up inside the decision transaction (401 without one).
pub(super) async fn verify_step_up(
    verifier: Option<&PasskeyService>,
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    envelope: Option<MobilePasskeyStepUpEnvelope>,
    user: Uuid,
    expected: &MobilePasskeyStepUpBinding,
) -> Result<Uuid, LifecycleError> {
    let envelope = envelope.ok_or_else(|| {
        coded(
            StatusCode::UNAUTHORIZED,
            "passkey_step_up_required",
            "a passkey step-up is required to unlock a period",
        )
    })?;
    let verifier = verifier.ok_or_else(|| {
        coded(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "passkey step-up is not configured",
        )
    })?;
    verifier
        .verify_and_record_step_up_in_tx(tx, envelope, user, expected)
        .await
        .map_err(|error| match error {
            MobilePasskeyStepUpVerificationError::BindingMismatch => coded(
                StatusCode::UNAUTHORIZED,
                "passkey_step_up_binding_mismatch",
                "passkey step-up binding does not match the requested unlock",
            ),
            MobilePasskeyStepUpVerificationError::Auth(AuthError::Sqlx(_) | AuthError::Db(_)) => {
                tracing::error!(%error, "period unlock step-up failed on the server");
                internal("passkey step-up could not be verified")
            }
            MobilePasskeyStepUpVerificationError::Auth(_) => coded(
                StatusCode::UNAUTHORIZED,
                "passkey_step_up_failed",
                "passkey step-up failed",
            ),
        })
}

pub(super) fn coded(status: StatusCode, code: &'static str, message: &str) -> LifecycleError {
    LifecycleError {
        status,
        code,
        message: message.to_owned(),
        errors: None,
    }
}

pub(super) fn internal(message: impl Into<String>) -> LifecycleError {
    LifecycleError::from_kernel(KernelError::internal(message.into()))
}

pub(super) fn unlock_event(
    actor: Uuid,
    org: OrgId,
    action: &str,
    object_id: Uuid,
    snapshot: Value,
) -> Result<AuditEvent, LifecycleError> {
    Ok(AuditEvent::new(
        Some(UserId::from_uuid(actor)),
        AuditAction::new(action)?,
        "period_lock",
        object_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(None, Some(snapshot)))
}

pub(super) fn request_json(request: &UnlockRequest) -> Value {
    json!({
        "id": request.id,
        "requestedBy": request.requested_by,
        "reasonCode": &request.reason_code,
        "reasonNote": &request.reason_note,
        "relockAt": request.relock_at.format(&Rfc3339).unwrap_or_default(),
        "requestedAt": request.requested_at.format(&Rfc3339).unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::{UnlockPath, approve_payload, request_status, unlock_path, unlock_payload};
    use time::{Duration, OffsetDateTime};
    use uuid::Uuid;

    #[test]
    fn a_request_reads_as_its_decision_or_its_window() {
        let now = OffsetDateTime::now_utc();
        let later = now + Duration::hours(1);
        for (outcome, relock_at, status) in [
            (None, later, "PENDING"),
            (None, now, "EXPIRED"),
            (None, now - Duration::hours(1), "EXPIRED"),
            (Some("APPROVED"), now, "APPROVED"),
            (Some("REJECTED"), later, "REJECTED"),
            (Some("SUPERSEDED"), later, "SUPERSEDED"),
        ] {
            assert_eq!(request_status(outcome, relock_at, now), status);
        }
    }

    #[test]
    fn a_second_person_wins_and_a_sole_holder_follows_the_mode() {
        assert_eq!(
            unlock_path("u", "o", 1, true, true, true),
            UnlockPath::SecondPerson
        );
        assert_eq!(
            unlock_path("u", "o", 0, false, true, true),
            UnlockPath::SoleHolderReview
        );
        assert_eq!(
            unlock_path("u", "o", 0, true, true, true),
            UnlockPath::Refused
        );
    }

    #[test]
    fn payloads_are_the_documented_lines() {
        let id = Uuid::nil();
        assert_eq!(
            unlock_payload(id, "PAYROLL_ERROR", "2026-10-07T00:00:00Z"),
            format!("PERIOD_UNLOCK\n{id}\nPAYROLL_ERROR\n2026-10-07T00:00:00Z")
        );
        assert_eq!(approve_payload(id), format!("PERIOD_UNLOCK_APPROVE\n{id}"));
    }
}
