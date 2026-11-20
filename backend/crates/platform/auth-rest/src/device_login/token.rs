use crate::cookies::refresh_set_cookie;
use crate::cookies::wants_cookie_transport;
use crate::cookies::with_refresh_cookie;
use crate::dto::device::DeviceLoginPollResponse;
use crate::error::RestError;
use crate::token::issue::IssuedTokenPair;
use aws_lc_rs::digest::{Context as DigestContext, SHA256, digest};
use aws_lc_rs::rand::{SecureRandom, SystemRandom};
use axum::Json;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::response::Response;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use time::OffsetDateTime;
use zeroize::Zeroizing;

const DEVICE_LOGIN_HASH_DOMAIN: &[u8] = b"console.device_login.v2\0";
const DEVICE_LOGIN_RANDOM_BYTES: usize = 32;
const DEVICE_LOGIN_V2_SUFFIX_LEN: usize = 43;
const DEVICE_LOGIN_V1_SUFFIX_LEN: usize = 64;

pub(crate) fn device_login_status(status: &'static str) -> DeviceLoginPollResponse {
    DeviceLoginPollResponse {
        status,
        access_token: None,
        refresh_token: None,
        token_type: None,
        refresh_expires_at: None,
        requires_passkey_setup: None,
        privacy_consent_accepted: None,
    }
}

pub(crate) fn device_login_token_response(
    tokens: IssuedTokenPair,
    headers: &HeaderMap,
) -> Response {
    if wants_cookie_transport(headers) {
        let max_age = (tokens.refresh_expires_at - OffsetDateTime::now_utc()).whole_seconds();
        let body = DeviceLoginPollResponse {
            status: "approved",
            access_token: Some(tokens.access_token),
            refresh_token: None,
            token_type: Some("Bearer"),
            refresh_expires_at: Some(tokens.refresh_expires_at),
            requires_passkey_setup: Some(false),
            privacy_consent_accepted: Some(tokens.privacy_consent_accepted),
        };
        with_refresh_cookie(
            Json(body).into_response(),
            refresh_set_cookie(&tokens.refresh_token, max_age),
        )
    } else {
        let body = DeviceLoginPollResponse {
            status: "approved",
            access_token: Some(tokens.access_token),
            refresh_token: Some(tokens.refresh_token),
            token_type: Some("Bearer"),
            refresh_expires_at: Some(tokens.refresh_expires_at),
            requires_passkey_setup: Some(false),
            privacy_consent_accepted: Some(tokens.privacy_consent_accepted),
        };
        Json(body).into_response()
    }
}

pub(crate) fn normalize_device_login_token(raw: &str, prefix: &str) -> Result<String, RestError> {
    let token = raw.trim();
    let suffix = token
        .strip_prefix(prefix)
        .ok_or_else(|| RestError::unauthorized("invalid or expired login handoff"))?;
    let is_v2 = suffix.len() == DEVICE_LOGIN_V2_SUFFIX_LEN
        && URL_SAFE_NO_PAD
            .decode(suffix)
            .is_ok_and(|decoded| decoded.len() == DEVICE_LOGIN_RANDOM_BYTES);
    let is_v1 = suffix.len() == DEVICE_LOGIN_V1_SUFFIX_LEN
        && suffix.bytes().all(|byte| byte.is_ascii_hexdigit());
    if !is_v2 && !is_v1 {
        return Err(RestError::unauthorized("invalid or expired login handoff"));
    }
    Ok(token.to_owned())
}

pub(crate) fn generate_device_login_token(prefix: &str) -> Result<String, RestError> {
    let rng = SystemRandom::new();
    let mut bytes = Zeroizing::new([0u8; DEVICE_LOGIN_RANDOM_BYTES]);
    rng.fill(&mut *bytes)
        .map_err(|_| RestError::internal("csprng unavailable"))?;
    let encoded = Zeroizing::new(URL_SAFE_NO_PAD.encode(*bytes));
    let mut out = String::with_capacity(prefix.len() + encoded.len());
    out.push_str(prefix);
    out.push_str(&encoded);
    Ok(out)
}

pub(crate) fn hash_device_login_token_v2(token: &str) -> Vec<u8> {
    let mut ctx = DigestContext::new(&SHA256);
    ctx.update(DEVICE_LOGIN_HASH_DOMAIN);
    ctx.update(token.as_bytes());
    ctx.finish().as_ref().to_vec()
}

pub(crate) fn hash_device_login_token_v1(token: &str) -> Vec<u8> {
    digest(&SHA256, token.as_bytes()).as_ref().to_vec()
}

pub(crate) fn hash_device_login_token_candidates(token: &str) -> [Vec<u8>; 2] {
    [
        hash_device_login_token_v2(token),
        hash_device_login_token_v1(token),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_device_login_token_accepts_v2_and_v1_rejects_malformed() {
        let v2_poll = generate_device_login_token("console_dlp_").unwrap();
        assert_eq!(
            v2_poll.strip_prefix("console_dlp_").unwrap().len(),
            DEVICE_LOGIN_V2_SUFFIX_LEN
        );
        assert_eq!(
            normalize_device_login_token(&format!("  {v2_poll}\n"), "console_dlp_").unwrap(),
            v2_poll
        );

        let v1_approve = format!("console_dla_{}", "a".repeat(64));
        assert_eq!(
            normalize_device_login_token(&v1_approve, "console_dla_").unwrap(),
            v1_approve
        );

        for bad in [
            "console_rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "console_dla_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            &format!("console_dlp_{}", "a".repeat(42)),
            &format!("console_dlp_{}", "a".repeat(44)),
            &format!("console_dlp_{}=", "a".repeat(42)),
            &format!("console_dlp_{}", "a".repeat(63)),
            &format!("console_dlp_{}", "a".repeat(65)),
            &format!("console_dlp_{}g", "a".repeat(63)),
        ] {
            let err = normalize_device_login_token(bad, "console_dlp_").unwrap_err();
            assert_eq!(err.status, axum::http::StatusCode::UNAUTHORIZED);
        }
    }

    #[test]
    fn device_login_token_v2_hash_is_domain_separated_from_v1_and_refresh() {
        let token = generate_device_login_token("console_dlp_").unwrap();
        let v2 = hash_device_login_token_v2(&token);
        let v1 = hash_device_login_token_v1(&token);
        assert_ne!(v2, v1);

        let mut refresh_ctx = DigestContext::new(&SHA256);
        refresh_ctx.update(b"console.refresh_token.v2\0");
        refresh_ctx.update(token.as_bytes());
        assert_ne!(v2, refresh_ctx.finish().as_ref());
    }
}
