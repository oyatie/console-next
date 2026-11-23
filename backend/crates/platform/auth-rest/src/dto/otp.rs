use serde::Deserialize;
use serde::Serialize;
use time::OffsetDateTime;

/// First sign-in via a one-time admin-issued (or cold-start) OTP. The body
/// carries only the OTP; the user is resolved from the consumed credential.
#[derive(Debug, Deserialize)]
pub(crate) struct OtpRedeemRequest {
    pub(crate) otp: String,
}

/// OTP first sign-in result: a normal session token pair plus a flag telling the
/// frontend to force passkey enrollment in initial settings.
///
/// `refresh_token` is `null` in the cookie transport (web): the token is set as
/// an HttpOnly cookie instead and must never reach web JS. It is `Some` in the
/// body transport (mobile).
#[derive(Debug, Serialize)]
pub(crate) struct OtpRedeemResponse {
    pub(crate) access_token: String,
    pub(crate) refresh_token: Option<String>,
    pub(crate) token_type: &'static str,
    #[serde(with = "time::serde::rfc3339")]
    pub(crate) refresh_expires_at: OffsetDateTime,
    pub(crate) requires_passkey_setup: bool,
    #[serde(with = "time::serde::rfc3339")]
    pub(crate) otp_expires_at: OffsetDateTime,
    pub(crate) otp_reusable: bool,
    pub(crate) privacy_consent_accepted: bool,
}
