//! BW-06 lifecycle: who an exception needs at request time (admission), the
//! second person's decision, and the single-use guard a governed write passes.
//!
//! Policy values (`exceptions.approval_ttl_days`, `authz.sole_holder.mode`,
//! `review.sole_holder_exception.due`) come in from the settings registry; the
//! facts (`other_eligible_holders`, step-up, contribution) are server-computed
//! inside the decision transaction (decisions.md D0.1, D0.2).

use std::time::Duration;

use console_kernel_core::{KernelError, Timestamp, UserId};
use serde::{Deserialize, Serialize};

use super::rule::{Risk, RuleCode, SubjectType};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExceptionStatus {
    /// Waiting for the second person.
    Pending,
    Approved,
    Declined,
    /// Admitted at request time (low, medium, or the high sole-holder fallback).
    Recorded,
}

impl ExceptionStatus {
    #[must_use]
    pub const fn as_db_str(self) -> &'static str {
        match self {
            Self::Pending => "PENDING",
            Self::Approved => "APPROVED",
            Self::Declined => "DECLINED",
            Self::Recorded => "RECORDED",
        }
    }
}

/// How a high-risk exception was covered (decisions.md #7 case B).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FallbackKind {
    SecondPerson,
    SoleHolder,
}

/// Setting `authz.sole_holder.mode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SoleHolderMode {
    StepUpNoticeReview,
    Refuse,
}

/// Server-computed facts at request time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdmissionFacts {
    /// D0.2 count, excluding the requester.
    pub other_eligible_holders: u64,
    /// A verified step-up bound to the payload hash.
    pub step_up: bool,
}

/// Settings values the decision was made under (also stored in `settings_snapshot`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExceptionSettings {
    pub approval_ttl_days: u16,
    pub sole_holder_mode: SoleHolderMode,
    pub sole_holder_review_due: Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Admission {
    pub status: ExceptionStatus,
    pub fallback_kind: Option<FallbackKind>,
    pub expires_at: Timestamp,
    pub review_due_at: Option<Timestamp>,
    /// Notice to every EXECUTIVE and SUPER_ADMIN, through the outbox in the same transaction.
    pub notify_executives: bool,
}

/// Decide how a new exception is admitted. Never a dead end: a high-risk rule
/// with no other eligible person falls back to step-up + notice + review,
/// unless the tenant chose `refuse`.
pub fn admit(
    risk: Risk,
    facts: AdmissionFacts,
    settings: &ExceptionSettings,
    now: Timestamp,
) -> Result<Admission, KernelError> {
    let expires_at = now + Duration::from_secs(u64::from(settings.approval_ttl_days) * 86_400);
    let recorded = |fallback_kind, review_due_at, notify_executives| Admission {
        status: ExceptionStatus::Recorded,
        fallback_kind,
        expires_at,
        review_due_at,
        notify_executives,
    };
    match risk {
        Risk::Low => Ok(recorded(None, None, false)),
        Risk::Medium => {
            require_step_up(facts.step_up)?;
            Ok(recorded(None, None, false))
        }
        Risk::High if facts.other_eligible_holders > 0 => Ok(Admission {
            status: ExceptionStatus::Pending,
            fallback_kind: Some(FallbackKind::SecondPerson),
            expires_at,
            review_due_at: None,
            notify_executives: false,
        }),
        Risk::High => {
            if settings.sole_holder_mode == SoleHolderMode::Refuse {
                return Err(KernelError::forbidden("exception_sole_holder_refused"));
            }
            require_step_up(facts.step_up)?;
            Ok(recorded(
                Some(FallbackKind::SoleHolder),
                Some(now + settings.sole_holder_review_due),
                true,
            ))
        }
    }
}

fn require_step_up(step_up: bool) -> Result<(), KernelError> {
    if step_up {
        Ok(())
    } else {
        Err(KernelError::forbidden("step_up_required"))
    }
}

/// The stored exception as the decide and admit paths see it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExceptionRecord {
    pub rule: RuleCode,
    pub status: ExceptionStatus,
    pub requested_by: UserId,
    pub subject_type: SubjectType,
    /// Subject UUID as `u128` (this crate depends on the kernel only).
    pub subject_id: u128,
    /// SHA-256 hex over the canonical payload plus `affected_periods[]`, computed by the adapter.
    pub fingerprint: String,
    pub expires_at: Timestamp,
    pub consumed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Approve,
    Decline,
}

/// Facts about the decider, computed by the server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeciderFacts {
    pub decider: UserId,
    /// The decider drafted or edited the subject (decisions.md #5 `actor_contributed`).
    pub contributed: bool,
    /// Step-up of kind `EXCEPTION_DECIDE`, bound to the payload hash.
    pub step_up: bool,
}

/// The second person's decision on a PENDING exception. Returns the new status.
pub fn decide(
    record: &ExceptionRecord,
    decision: Decision,
    decider: DeciderFacts,
    now: Timestamp,
) -> Result<ExceptionStatus, KernelError> {
    if record.status != ExceptionStatus::Pending {
        return Err(KernelError::invalid_transition("exception_not_pending"));
    }
    if now >= record.expires_at {
        return Err(KernelError::conflict("exception_expired"));
    }
    if decider.decider == record.requested_by {
        return Err(KernelError::forbidden("exception_self_decision"));
    }
    if decider.contributed {
        return Err(KernelError::forbidden("exception_contributor_decision"));
    }
    match decision {
        Decision::Approve => {
            require_step_up(decider.step_up)?;
            Ok(ExceptionStatus::Approved)
        }
        Decision::Decline => Ok(ExceptionStatus::Declined),
    }
}

/// The shared guard: an exception admits exactly one governed write for its
/// rule, subject and fingerprint. The caller names the rule its write needs, so
/// a low-risk exception recorded for the same payload never admits a write
/// that needs a high-risk one. The caller consumes it in the same transaction.
pub fn check_admits(
    record: &ExceptionRecord,
    rule: RuleCode,
    subject_type: SubjectType,
    subject_id: u128,
    fingerprint: &str,
    now: Timestamp,
) -> Result<(), KernelError> {
    if !matches!(
        record.status,
        ExceptionStatus::Approved | ExceptionStatus::Recorded
    ) {
        return Err(KernelError::conflict("exception_not_approved"));
    }
    if record.consumed {
        return Err(KernelError::conflict("exception_consumed"));
    }
    if now >= record.expires_at {
        return Err(KernelError::conflict("exception_expired"));
    }
    if record.rule != rule
        || record.subject_type != subject_type
        || record.subject_id != subject_id
        || record.fingerprint != fingerprint
    {
        return Err(KernelError::conflict("exception_scope_changed"));
    }
    Ok(())
}

#[cfg(test)]
#[path = "policy_tests.rs"]
mod tests;
