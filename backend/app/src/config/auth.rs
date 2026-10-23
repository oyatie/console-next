//! JWT verifier, auth-REST, support issuer and policy step-up configuration.

use crate::config::DEFAULT_AUTH_CEREMONY_TTL_SECS;
use crate::config::DEFAULT_REFRESH_FAMILY_ABSOLUTE_TTL_SECS;
use crate::config::DEFAULT_REFRESH_TOKEN_TTL_SECS;
use crate::config::DEFAULT_WEBAUTHN_RP_NAME;
use crate::config::parse::non_empty;
use crate::config::parse::parse_time_duration_secs;
use crate::error::AppError;
use console_platform_auth::{
    JwtIssuer, JwtSettings, JwtVerifier, PasskeyService, WebauthnSettings,
};
use console_platform_auth_rest::AuthRestConfig;
use std::collections::HashMap;
use url::Url;

const E2E_ACCESS_TOKEN_TTL_SECS: &str = "CONSOLE_E2E_ACCESS_TOKEN_TTL_SECS";
const DEFAULT_ACCESS_TOKEN_TTL_SECS: u64 = 15 * 60;

#[derive(Debug, Clone)]
pub struct JwtVerifierConfig {
    pub issuer: String,
    pub audience: String,
    pub access_token_ttl: time::Duration,
    /// The verification key set as PEM blocks, current key first
    /// ([`verification_key_set`]).
    pub public_key_pem: String,
}

/// `CONSOLE_JWT_PUBLIC_KEY_PEM` (the signing key's public half) followed by every
/// `CONSOLE_JWT_ROTATION_PUBLIC_KEYS` entry: base64 SPKI DER (a PEM body on one
/// line), space-separated, because `settings.env` is line-oriented. Public keys
/// are configuration, not secrets. Outside a rotation the variable is empty.
pub(crate) fn verification_key_set(
    current_pem: String,
    rotation: Option<String>,
) -> Result<String, AppError> {
    let mut set = current_pem;
    for body in rotation.iter().flat_map(|keys| keys.split_whitespace()) {
        if !body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
        {
            return Err(AppError::Config(
                "CONSOLE_JWT_ROTATION_PUBLIC_KEYS entries must be base64 SPKI (a PEM body on one line)"
                    .to_owned(),
            ));
        }
        set.push_str("\n-----BEGIN PUBLIC KEY-----");
        for (i, c) in body.chars().enumerate() {
            // RFC 7468 §2: base64 lines of 64 characters.
            if i % 64 == 0 {
                set.push('\n');
            }
            set.push(c);
        }
        set.push_str("\n-----END PUBLIC KEY-----\n");
    }
    Ok(set)
}

impl JwtVerifierConfig {
    pub(crate) fn build(&self) -> Result<JwtVerifier, AppError> {
        JwtVerifier::from_es256_public_pem(
            JwtSettings {
                issuer: self.issuer.clone(),
                audience: self.audience.clone(),
                access_token_ttl: self.access_token_ttl,
            },
            self.public_key_pem.as_bytes(),
        )
        .map_err(|err| {
            AppError::Config(format!(
                "invalid CONSOLE_JWT_PUBLIC_KEY_PEM or CONSOLE_JWT_ROTATION_PUBLIC_KEYS: {err}"
            ))
        })
    }
}

/// Build the JWT issuer the PLATFORM support START path uses to mint short-lived
/// roleless support tokens for the configured tenant origin. The START handler
/// resolves the policy ceiling and binds the token to its operator session.
pub(crate) fn build_support_issuer(config: &AuthRestConfig) -> Result<JwtIssuer, AppError> {
    JwtIssuer::from_es256_pem(
        JwtSettings {
            issuer: config.jwt_issuer.clone(),
            audience: config.rp_origin.clone(),
            access_token_ttl: config.access_token_ttl,
        },
        config.jwt_private_key_pem.as_bytes(),
        config.jwt_public_key_pem.as_bytes(),
    )
    .map_err(|err| AppError::Config(format!("invalid support issuer key material: {err}")))
}

pub(crate) fn policy_step_up_from_auth_config(
    config: &AuthRestConfig,
) -> Result<PasskeyService, AppError> {
    let rp_origin = Url::parse(&config.rp_origin)
        .map_err(|err| AppError::Config(format!("invalid WebAuthn RP origin: {err}")))?;
    PasskeyService::new(WebauthnSettings {
        rp_id: config.rp_id.clone(),
        rp_origin,
        rp_name: config.rp_name.clone(),
        extra_allowed_origins: Vec::new(),
        ceremony_ttl: config.ceremony_ttl,
    })
    .map_err(|err| AppError::Config(format!("invalid policy step-up WebAuthn config: {err}")))
}

pub(crate) fn auth_rest_config_from_vars(
    vars: &HashMap<String, String>,
    jwt: Option<&JwtVerifierConfig>,
) -> Result<Option<AuthRestConfig>, AppError> {
    let Some(jwt_private_key_pem) = non_empty(vars.get("CONSOLE_JWT_PRIVATE_KEY_PEM")) else {
        return Ok(None);
    };
    let jwt = jwt.ok_or_else(|| {
        AppError::Config(
            "CONSOLE_JWT_PUBLIC_KEY_PEM is required when CONSOLE_JWT_PRIVATE_KEY_PEM is configured"
                .to_owned(),
        )
    })?;
    let rp_id = non_empty(vars.get("CONSOLE_WEBAUTHN_RP_ID")).ok_or_else(|| {
        AppError::Config(
            "CONSOLE_WEBAUTHN_RP_ID is required when auth REST is configured".to_owned(),
        )
    })?;
    let rp_origin = non_empty(vars.get("CONSOLE_WEBAUTHN_RP_ORIGIN")).ok_or_else(|| {
        AppError::Config(
            "CONSOLE_WEBAUTHN_RP_ORIGIN is required when auth REST is configured".to_owned(),
        )
    })?;

    Ok(Some(AuthRestConfig {
        rp_id,
        rp_origin,
        rp_name: non_empty(vars.get("CONSOLE_WEBAUTHN_RP_NAME"))
            .unwrap_or_else(|| DEFAULT_WEBAUTHN_RP_NAME.to_owned()),
        ceremony_ttl: parse_time_duration_secs(
            vars.get("CONSOLE_AUTH_CEREMONY_TTL_SECS"),
            DEFAULT_AUTH_CEREMONY_TTL_SECS,
            "CONSOLE_AUTH_CEREMONY_TTL_SECS",
        )?,
        jwt_issuer: jwt.issuer.clone(),
        jwt_audience: jwt.audience.clone(),
        access_token_ttl: jwt.access_token_ttl,
        jwt_private_key_pem,
        jwt_public_key_pem: jwt.public_key_pem.clone(),
        refresh_token_ttl: parse_time_duration_secs(
            vars.get("CONSOLE_REFRESH_TOKEN_TTL_SECS"),
            DEFAULT_REFRESH_TOKEN_TTL_SECS,
            "CONSOLE_REFRESH_TOKEN_TTL_SECS",
        )?,
        refresh_family_absolute_ttl: parse_time_duration_secs(
            vars.get("CONSOLE_REFRESH_FAMILY_ABSOLUTE_TTL_SECS"),
            DEFAULT_REFRESH_FAMILY_ABSOLUTE_TTL_SECS,
            "CONSOLE_REFRESH_FAMILY_ABSOLUTE_TTL_SECS",
        )?,
        cookie_secure: parse_cookie_secure(vars.get("CONSOLE_COOKIE_SECURE"))?,
    }))
}

pub(crate) fn access_token_ttl_from_vars(
    vars: &HashMap<String, String>,
) -> Result<time::Duration, AppError> {
    let ttl = non_empty(vars.get(E2E_ACCESS_TOKEN_TTL_SECS));
    if ttl.is_some() && !cfg!(any(debug_assertions, feature = "e2e-test-support")) {
        return Err(AppError::Config(format!(
            "{E2E_ACCESS_TOKEN_TTL_SECS} is only available in a debug or e2e-test-support build"
        )));
    }
    if ttl.is_some() && non_empty(vars.get("CONSOLE_EMAIL_STUB_MODE")).as_deref() != Some("e2e") {
        return Err(AppError::Config(format!(
            "{E2E_ACCESS_TOKEN_TTL_SECS} is only allowed when CONSOLE_EMAIL_STUB_MODE=e2e"
        )));
    }
    parse_time_duration_secs(
        ttl.as_ref(),
        DEFAULT_ACCESS_TOKEN_TTL_SECS,
        E2E_ACCESS_TOKEN_TTL_SECS,
    )
}

/// Whether the web refresh cookie carries the `Secure` attribute. Defaults to
/// `true` (production over HTTPS); set `CONSOLE_COOKIE_SECURE=false` only for local
/// http dev, where a `Secure` cookie would be dropped on `http://localhost`.
fn parse_cookie_secure(raw: Option<&String>) -> Result<bool, AppError> {
    match non_empty(raw) {
        Some(value) => value
            .parse::<bool>()
            .map_err(|err| AppError::Config(format!("invalid CONSOLE_COOKIE_SECURE: {err}"))),
        None => Ok(true),
    }
}

#[cfg(test)]
mod tests {
    use super::access_token_ttl_from_vars;
    use std::collections::HashMap;
    use time::Duration;

    #[test]
    fn access_token_ttl_defaults_to_fifteen_minutes() {
        assert_eq!(
            access_token_ttl_from_vars(&HashMap::new()).unwrap(),
            Duration::minutes(15)
        );
    }

    #[test]
    fn short_access_token_ttl_requires_explicit_e2e_stub_mode() {
        let vars = HashMap::from([
            ("CONSOLE_EMAIL_STUB_MODE".to_owned(), "e2e".to_owned()),
            (
                "CONSOLE_E2E_ACCESS_TOKEN_TTL_SECS".to_owned(),
                "180".to_owned(),
            ),
        ]);
        assert_eq!(
            access_token_ttl_from_vars(&vars).unwrap(),
            Duration::seconds(180)
        );

        let vars = HashMap::from([(
            "CONSOLE_E2E_ACCESS_TOKEN_TTL_SECS".to_owned(),
            "180".to_owned(),
        )]);
        assert!(
            access_token_ttl_from_vars(&vars)
                .unwrap_err()
                .to_string()
                .contains("CONSOLE_EMAIL_STUB_MODE=e2e")
        );
    }
}
