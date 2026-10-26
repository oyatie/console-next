//! The step-up kinds: the twelve acts a step-up ceremony can authorize
//! (migration 0144, widened by BW-29 in 0254; the lists must match).

use serde::{Deserialize, Serialize};

use crate::AuthError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MobileStepUpActionKind {
    ApprovalDecision,
    PollVote,
    ExitConfirm,
    ExitRescind,
    ElevatedGrant,
    PeriodUnlock,
    IdentityMerge,
    ExceptionDecide,
    SettingsChange,
    CredentialReset,
    TenantOffboard,
    OperatorRecovery,
    SupportSession,
    PiiReveal,
    PiiRecord,
}

impl MobileStepUpActionKind {
    /// Every kind, in the migration's order.
    pub const ALL: [Self; 15] = [
        Self::ApprovalDecision,
        Self::PollVote,
        Self::ExitConfirm,
        Self::ExitRescind,
        Self::ElevatedGrant,
        Self::PeriodUnlock,
        Self::IdentityMerge,
        Self::ExceptionDecide,
        Self::SettingsChange,
        Self::CredentialReset,
        Self::TenantOffboard,
        Self::OperatorRecovery,
        Self::SupportSession,
        Self::PiiReveal,
        Self::PiiRecord,
    ];

    /// The two pre-BW-29 mobile kinds: no payload hash, replay attempts allowed.
    pub const fn is_legacy(self) -> bool {
        matches!(self, Self::ApprovalDecision | Self::PollVote)
    }

    pub const fn as_wire(self) -> &'static str {
        match self {
            Self::ApprovalDecision => "APPROVAL_DECISION",
            Self::PollVote => "POLL_VOTE",
            Self::ExitConfirm => "EXIT_CONFIRM",
            Self::ExitRescind => "EXIT_RESCIND",
            Self::ElevatedGrant => "ELEVATED_GRANT",
            Self::PeriodUnlock => "PERIOD_UNLOCK",
            Self::IdentityMerge => "IDENTITY_MERGE",
            Self::ExceptionDecide => "EXCEPTION_DECIDE",
            Self::SettingsChange => "SETTINGS_CHANGE",
            Self::CredentialReset => "CREDENTIAL_RESET",
            Self::TenantOffboard => "TENANT_OFFBOARD",
            Self::OperatorRecovery => "OPERATOR_RECOVERY",
            Self::SupportSession => "SUPPORT_SESSION",
            Self::PiiReveal => "PII_REVEAL",
            Self::PiiRecord => "PII_RECORD",
        }
    }

    pub const fn expected_reason_key(self) -> &'static str {
        match self {
            Self::ApprovalDecision => "operations_passkey_approval_decision",
            Self::PollVote => "operations_passkey_poll_vote",
            Self::ExitConfirm => "passkey_step_up_exit_confirm",
            Self::ExitRescind => "passkey_step_up_exit_rescind",
            Self::ElevatedGrant => "passkey_step_up_elevated_grant",
            Self::PeriodUnlock => "passkey_step_up_period_unlock",
            Self::IdentityMerge => "passkey_step_up_identity_merge",
            Self::ExceptionDecide => "passkey_step_up_exception_decide",
            Self::SettingsChange => "passkey_step_up_settings_change",
            Self::CredentialReset => "passkey_step_up_credential_reset",
            Self::TenantOffboard => "passkey_step_up_tenant_offboard",
            Self::OperatorRecovery => "passkey_step_up_operator_recovery",
            Self::SupportSession => "passkey_step_up_support_session",
            Self::PiiReveal => "passkey_step_up_pii_reveal",
            Self::PiiRecord => "passkey_step_up_pii_record",
        }
    }

    pub(super) fn from_wire(raw: &str) -> Result<Self, AuthError> {
        Self::ALL
            .into_iter()
            .find(|kind| kind.as_wire() == raw)
            .ok_or_else(|| {
                AuthError::InvalidStoredData(format!("unknown mobile step-up action kind: {raw}"))
            })
    }
}
