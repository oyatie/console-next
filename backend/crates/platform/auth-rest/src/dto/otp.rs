use serde::Deserialize;
use serde::Serialize;
use time::OffsetDateTime;

/// Open self-service signup (#38). The body carries only the email address; the
/// server creates a new low-privilege MEMBER account, mints a one-time code, and
/// emails it. The caller then redeems that code via `/auth/otp/redeem` and
/// enrolls a passkey — the same flow a pre-provisioned user follows.
#[derive(Debug, Deserialize)]
pub(crate) struct SignupRequest {
    pub(crate) email: String,
}

/// Signup acknowledgement. Deliberately reveals NOTHING about whether the email
/// was newly registered — a one-time code is "sent" (logged by the stub in
/// dev/e2e) and the client always proceeds to the OTP step. No token is minted
/// here; sign-in happens only after the code is redeemed.
#[derive(Debug, Serialize)]
pub(crate) struct SignupResponse {
    /// Always `true`. Present so the response body is non-empty and the contract
    /// is stable if richer status is added later.
    pub(crate) accepted: bool,
}

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
}
