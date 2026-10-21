use crate::cookies::refresh_set_cookie;
use crate::cookies::wants_cookie_transport;
use crate::cookies::with_refresh_cookie;
use crate::dto::device::DeviceLoginPollResponse;
use crate::error::RestError;
use crate::token::issue::IssuedTokenPair;
use axum::Json;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::response::Response;
use sha2::Digest;
use sha2::Sha256;
use time::OffsetDateTime;
use uuid::Uuid;

pub(crate) fn device_login_status(status: &'static str) -> DeviceLoginPollResponse {
    DeviceLoginPollResponse {
        status,
        access_token: None,
        refresh_token: None,
        token_type: None,
        refresh_expires_at: None,
        requires_passkey_setup: None,
    }
}

pub(crate) fn device_login_token_response(
    tokens: IssuedTokenPair,
    headers: &HeaderMap,
    cookie_secure: bool,
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
        };
        with_refresh_cookie(
            Json(body).into_response(),
            refresh_set_cookie(&tokens.refresh_token, max_age, cookie_secure),
        )
    } else {
        let body = DeviceLoginPollResponse {
            status: "approved",
            access_token: Some(tokens.access_token),
            refresh_token: Some(tokens.refresh_token),
            token_type: Some("Bearer"),
            refresh_expires_at: Some(tokens.refresh_expires_at),
            requires_passkey_setup: Some(false),
        };
        Json(body).into_response()
    }
}

pub(crate) fn normalize_device_login_token(raw: &str, prefix: &str) -> Result<String, RestError> {
    let token = raw.trim();
    let suffix = token
        .strip_prefix(prefix)
        .ok_or_else(|| RestError::unauthorized("invalid or expired login handoff"))?;
    if suffix.len() != 64 || !suffix.chars().all(|char| char.is_ascii_hexdigit()) {
        return Err(RestError::unauthorized("invalid or expired login handoff"));
    }
    Ok(token.to_owned())
}

pub(crate) fn generate_device_login_token(prefix: &str) -> String {
    let mut bytes = [0u8; 32];
    bytes[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    format!("{prefix}{}", hex_encode(&bytes))
}

pub(crate) fn hash_device_login_token(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}
