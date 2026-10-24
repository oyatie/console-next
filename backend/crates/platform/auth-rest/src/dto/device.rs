use crate::dto::passkey::StepUpAssertion;
use console_platform_auth::PasskeyAuthenticationCredential;
use serde::Deserialize;
use serde::Serialize;
use time::OffsetDateTime;
use uuid::Uuid;

/// Cross-device self passkey-enrollment handoff request. The body carries NO
/// user/org — those come from the caller's verified access token, so a caller can
/// only ever mint a handoff for ITSELF. `step_up` is required ONLY when the caller
/// is already enrolled (add-device): exactly like `register/start`, an
/// already-enrolled user must assert an existing passkey (UV) before a fresh
/// enrollment credential is issued, so a stolen bearer token alone cannot mint a
/// device-enrollment handoff. A mid-onboarding user (zero passkeys) omits it.
#[derive(Debug, Deserialize, Default)]
pub(crate) struct EnrollHandoffRequest {
    pub(crate) step_up: Option<StepUpAssertion>,
}

/// The minted single-use, short-TTL passkey-enrollment handoff code (returned
/// once, never stored in plaintext) plus the ready-to-encode enrollment URL the
/// frontend renders as a QR. The phone opens `enroll_url`, redeems the `otp` via
/// the ordinary first-sign-in path, and enrolls a platform passkey on the phone.
#[derive(Debug, Serialize)]
pub(crate) struct EnrollHandoffResponse {
    pub(crate) otp: String,
    #[serde(with = "time::serde::rfc3339")]
    pub(crate) expires_at: OffsetDateTime,
    pub(crate) enroll_url: String,
    /// Desktop poll token paired to this phone-enrollment QR. Present so the PC
    /// can finish its own session after the phone registers/authenticates.
    pub(crate) poll_token: String,
}

/// Desktop-initiated, phone-approved login handoff. The poll token stays only in
/// the desktop browser; the approve URL carries a distinct token for the phone.
#[derive(Debug, Serialize)]
pub(crate) struct DeviceLoginStartResponse {
    pub(crate) poll_token: String,
    pub(crate) approve_url: String,
    #[serde(with = "time::serde::rfc3339")]
    pub(crate) expires_at: OffsetDateTime,
}

#[derive(Debug, Deserialize)]
pub(crate) struct DeviceLoginPollRequest {
    pub(crate) poll_token: String,
}

/// Poll response for the desktop. Pending/expired responses carry no tokens; an
/// approved response carries a normal token pair and sets the web refresh cookie
/// when the caller uses cookie transport.
#[derive(Debug, Serialize)]
pub(crate) struct DeviceLoginPollResponse {
    pub(crate) status: &'static str,
    pub(crate) access_token: Option<String>,
    pub(crate) refresh_token: Option<String>,
    pub(crate) token_type: Option<&'static str>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub(crate) refresh_expires_at: Option<OffsetDateTime>,
    pub(crate) requires_passkey_setup: Option<bool>,
    pub(crate) privacy_consent_accepted: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct DeviceLoginApproveRequest {
    pub(crate) approve_token: String,
    pub(crate) ceremony_id: Uuid,
    pub(crate) credential: PasskeyAuthenticationCredential,
}

#[derive(Debug, Deserialize)]
pub(crate) struct DeviceLoginApproveSessionRequest {
    pub(crate) approve_token: String,
}
