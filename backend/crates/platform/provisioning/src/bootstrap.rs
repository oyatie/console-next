mod cold_start;
mod consume;
mod issue;
mod issue_tx;
mod redeem;
mod reset;
mod token;

pub(crate) use issue_tx::*;
pub(crate) use token::*;

use console_kernel_core::OrgId;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootstrapToken(String);

impl BootstrapToken {
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootstrapCredentialIssue {
    pub credential_id: Uuid,
    pub user_id: Uuid,
    pub token: BootstrapToken,
    pub expires_at: OffsetDateTime,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct BootstrapCredentialStore;

/// Outcome of a successful OTP first sign-in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OtpRedemption {
    /// The pre-provisioned user the OTP belonged to; the caller mints a session
    /// for this user.
    pub user_id: Uuid,
    /// The tenant the redeemed credential belongs to, resolved from the token
    /// hash BEFORE the RLS-gated read. The caller arms the GUC with it to load
    /// the user and mint the session, since the OTP redeem route runs before the
    /// tenant middleware.
    pub org_id: OrgId,
    /// True when the user has no registered passkey yet, so the frontend should
    /// force passkey enrollment during initial settings.
    pub requires_passkey_setup: bool,
    /// Exact row and immutable provenance read under the source lock. Version 0
    /// retains NULL provenance; callers must not upgrade it by inference.
    pub source: OtpSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OtpSource {
    pub credential_id: Uuid,
    pub issuance_version: i16,
    pub issued_generation: Option<i64>,
    pub issuance_purpose: Option<String>,
    pub source_operation_id: Option<Uuid>,
}
