use console_platform_auth::MobilePasskeyStepUpBinding;
use console_platform_auth::PasskeyAuthenticationCredential;
use console_platform_auth::PasskeyRegistrationCredential;
use serde::Deserialize;
use serde::Serialize;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub(crate) struct RegisterStartRequest {
    pub(crate) username: Option<String>,
    pub(crate) display_name: Option<String>,
    /// Fresh step-up assertion of an EXISTING passkey, REQUIRED when the
    /// authenticated user already has one or more passkeys (self-service
    /// add-device). Omitted only for initial enrollment (the user has zero
    /// passkeys). The ceremony id comes from a preceding `passkey/login/start`.
    pub(crate) step_up: Option<StepUpAssertion>,
}

/// A step-up proof: a discoverable authentication ceremony id plus the asserted
/// credential. Verified with user verification (UV) required before a new
/// credential is issued, so a stolen session alone cannot add a passkey.
#[derive(Debug, Deserialize)]
pub(crate) struct StepUpAssertion {
    pub(crate) ceremony_id: Uuid,
    pub(crate) credential: PasskeyAuthenticationCredential,
}

#[derive(Debug, Serialize)]
pub(crate) struct RegisterStartResponse {
    pub(crate) ceremony_id: Uuid,
    pub(crate) challenge: serde_json::Value,
    #[serde(with = "time::serde::rfc3339")]
    pub(crate) expires_at: OffsetDateTime,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RegisterFinishRequest {
    pub(crate) ceremony_id: Uuid,
    pub(crate) credential: PasskeyRegistrationCredential,
}

#[derive(Debug, Serialize)]
pub(crate) struct RegisterFinishResponse {
    pub(crate) passkey_id: Uuid,
    pub(crate) user_id: Uuid,
    pub(crate) credential_id: String,
    /// `<아이디>@<회사 도메인>`: the client's sign-in right after enrollment.
    pub(crate) sign_in_id: Option<String>,
}

/// Optional body of `passkey/login/start`. With `identifier` the challenge
/// names that account's credentials (decisions #33); without it (the autofill
/// and button paths, and an N-1 client) it is usernameless.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LoginStartRequest {
    #[serde(default)]
    pub(crate) identifier: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct LoginStartResponse {
    pub(crate) ceremony_id: Uuid,
    pub(crate) challenge: serde_json::Value,
    #[serde(with = "time::serde::rfc3339")]
    pub(crate) expires_at: OffsetDateTime,
}

#[derive(Debug, Deserialize)]
pub(crate) struct MobilePasskeyStepUpStartRequest {
    pub(crate) binding: MobilePasskeyStepUpBinding,
}

#[derive(Debug, Serialize)]
pub(crate) struct MobilePasskeyStepUpStartResponse {
    pub(crate) ceremony_id: Uuid,
    pub(crate) challenge: serde_json::Value,
    #[serde(with = "time::serde::rfc3339")]
    pub(crate) expires_at: OffsetDateTime,
    pub(crate) binding: MobilePasskeyStepUpBinding,
}

#[derive(Debug, Deserialize)]
pub(crate) struct LoginFinishRequest {
    pub(crate) ceremony_id: Uuid,
    pub(crate) credential: PasskeyAuthenticationCredential,
}

/// Passkey credential summary for the authenticated user's self-management
/// surface. Carries no secret material: never the raw credential id, public key,
/// or serialized passkey blob.
#[derive(Debug, Serialize)]
pub(crate) struct PasskeySummary {
    pub(crate) id: Uuid,
    #[serde(with = "time::serde::rfc3339")]
    pub(crate) created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub(crate) last_used_at: Option<OffsetDateTime>,
}
