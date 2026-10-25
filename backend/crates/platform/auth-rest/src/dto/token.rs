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
    pub(crate) privacy_consent_accepted: bool,
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

impl PasskeyProfile {
    /// WebAuthn names the account by its identifier, with a non-blank friendly label.
    pub(crate) fn new(user_id: uuid::Uuid, username: &str, display_name: &str) -> Self {
        let name = username.trim();
        let name = if name.is_empty() {
            user_id.to_string()
        } else {
            name.to_owned()
        };
        let display_name = display_name.trim();
        Self {
            user_id,
            display_name: if display_name.is_empty() {
                name.clone()
            } else {
                display_name.to_owned()
            },
            name,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::PasskeyProfile;

    #[test]
    fn authenticator_names_use_the_identifier_and_first_nonblank_friendly_name() {
        let user = uuid::Uuid::new_v4();
        let named = PasskeyProfile::new(user, " operator@platform ", " 박관리자 ");
        assert_eq!(named.name, "operator@platform");
        assert_eq!(named.display_name, "박관리자");
        for blank in ["", "   "] {
            let unnamed = PasskeyProfile::new(user, "operator@platform", blank);
            assert_eq!(unnamed.display_name, unnamed.name);
            let missing_identifier = PasskeyProfile::new(user, blank, blank);
            assert_eq!(missing_identifier.name, user.to_string());
            assert_eq!(missing_identifier.display_name, missing_identifier.name);
        }
    }
}
