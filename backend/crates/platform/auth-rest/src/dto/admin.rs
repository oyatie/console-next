use crate::dto::passkey::StepUpAssertion;
use serde::Deserialize;
use serde::Serialize;
use time::OffsetDateTime;
use uuid::Uuid;

/// Admin request to issue a one-time sign-in OTP for a pre-provisioned,
/// zero-credential user. `ttl_seconds` is optional and defaults to 24h.
#[derive(Debug, Deserialize)]
pub(crate) struct AdminIssueOtpRequest {
    pub(crate) user_id: Uuid,
    /// Required only for a branch-scoped target. An org-wide target (EXECUTIVE /
    /// SUPER_ADMIN) has no branch basis, and a brand-new tenant has no branches yet,
    /// so its first colleagues must be invitable without one.
    #[serde(default)]
    pub(crate) branch_id: Option<Uuid>,
    pub(crate) ttl_seconds: Option<i64>,
    /// The CALLER's fresh assertion of one of their own passkeys (ceremony
    /// from `passkey/login/start`), required so a stolen bearer token alone
    /// cannot mint a sign-in code for anyone.
    pub(crate) step_up: Option<StepUpAssertion>,
}

/// The issued one-time OTP (returned once, never stored in plaintext) and its
/// expiry. The caller relays this to the new user out-of-band.
#[derive(Debug, Serialize)]
pub(crate) struct AdminIssueOtpResponse {
    pub(crate) user_id: Uuid,
    pub(crate) otp: String,
    #[serde(with = "time::serde::rfc3339")]
    pub(crate) expires_at: OffsetDateTime,
}

/// Admin request to reset a user's credentials for account recovery: revokes ALL
/// the target's passkeys and mints a fresh single-use sign-in OTP. The target
/// lives in the caller's own tenant. `step_up` is the CALLER's fresh assertion
/// of one of their own passkeys (ceremony from `passkey/login/start`), required
/// so a stolen bearer token alone cannot take over another account.
#[derive(Debug, Deserialize)]
pub(crate) struct AdminCredentialResetRequest {
    pub(crate) user_id: Uuid,
    pub(crate) step_up: Option<StepUpAssertion>,
}

/// The fresh one-time OTP minted by a credential reset (returned once, never
/// stored in plaintext) and its expiry. The admin relays this to the locked-out
/// user out-of-band so they can sign in and re-enroll a passkey.
#[derive(Debug, Serialize)]
pub(crate) struct AdminCredentialResetResponse {
    pub(crate) user_id: Uuid,
    pub(crate) otp: String,
    #[serde(with = "time::serde::rfc3339")]
    pub(crate) expires_at: OffsetDateTime,
}
