use serde::Deserialize;
use serde::Serialize;
use time::OffsetDateTime;

/// A minted access/refresh pair. `refresh_token` is `null` in the cookie
/// transport (web) — the refresh token rides in the HttpOnly `console_refresh`
/// cookie instead — and `Some` in the body transport (mobile). The access token
/// is ALWAYS in the body: it stays a short-lived in-memory bearer token, never a
/// cookie. `requires_passkey_setup` is true only for an ordinary session whose
/// user still has zero passkeys, so a refresh cannot bypass initial enrollment.
/// A `dev-auth` build exempts only its authenticated synthetic role-switch
/// personas; ordinary users keep this production behavior in the same binary.
#[derive(Debug, Serialize)]
pub(crate) struct TokenPairResponse {
    pub(crate) access_token: String,
    pub(crate) refresh_token: Option<String>,
    pub(crate) token_type: &'static str,
    #[serde(with = "time::serde::rfc3339")]
    pub(crate) refresh_expires_at: OffsetDateTime,
    pub(crate) requires_passkey_setup: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) passkey_profile: Option<PasskeyProfile>,
}

/// The refresh-token body is OPTIONAL: web (cookie transport) sends the token in
/// the `console_refresh` cookie and an empty/absent body, while mobile sends it here.
#[derive(Debug, Deserialize, Default)]
pub(crate) struct RefreshTokenRequest {
    pub(crate) refresh_token: Option<String>,
}

/// Logout accepts the refresh token from the `console_refresh` cookie (web) or from
/// this body (mobile); the field is therefore optional.
#[derive(Debug, Deserialize, Default)]
pub(crate) struct LogoutRequest {
    pub(crate) refresh_token: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct PasskeyProfile {
    pub(crate) user_id: uuid::Uuid,
    pub(crate) name: String,
    pub(crate) display_name: String,
}
