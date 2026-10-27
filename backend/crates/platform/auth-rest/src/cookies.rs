use crate::dto::token::TokenPairResponse;
use crate::error::RestError;
use crate::token::issue::IssuedTokenPair;
use axum::Json;
use axum::http::HeaderMap;
use axum::http::HeaderValue;
use axum::http::header;
use axum::response::IntoResponse;
use axum::response::Response;
use time::OffsetDateTime;

/// Request header a WEB client sets to opt into the cookie transport for the
/// refresh token. Mobile (iOS/Android) clients never send it and keep the
/// body-based refresh token. The value must equal [`AUTH_TRANSPORT_COOKIE`].
pub(crate) const AUTH_TRANSPORT_HEADER: &str = "x-auth-transport";
/// The single recognized value of [`AUTH_TRANSPORT_HEADER`].
pub(crate) const AUTH_TRANSPORT_COOKIE: &str = "cookie";
/// Name of the HttpOnly refresh-token cookie used by the web transport.
pub(crate) const REFRESH_COOKIE_NAME: &str = "__Host-console_refresh";
/// The __Host- prefix requires Secure, Path=/ and no Domain attribute.
pub(crate) const REFRESH_COOKIE_PATH: &str = "/";
// shortcut: N-1 migration from 2026-10-27, remove legacy acceptance/clearing after one production release.
const LEGACY_REFRESH_COOKIE_NAME: &str = "console_refresh";
const LEGACY_REFRESH_CLEAR_COOKIE: &str =
    "console_refresh=; HttpOnly; SameSite=Strict; Path=/api/v1/auth; Max-Age=0; Secure";

// ---------------------------------------------------------------------------
// Dual-transport refresh token: web=HttpOnly cookie, mobile=JSON body.
// ---------------------------------------------------------------------------

/// True when the caller opted into the cookie transport via
/// `X-Auth-Transport: cookie` (the web client). Mobile clients omit the header
/// and keep the body-based refresh token, so they take the `false` branch.
pub(crate) fn wants_cookie_transport(headers: &HeaderMap) -> bool {
    headers
        .get(AUTH_TRANSPORT_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .is_some_and(|value| value.eq_ignore_ascii_case(AUTH_TRANSPORT_COOKIE))
}

pub(crate) fn select_refresh_credential(
    headers: &HeaderMap,
    body_token: Option<String>,
    expected_origin: &str,
) -> Result<Option<String>, RestError> {
    let refuse = || RestError::forbidden("invalid refresh cookie request");
    let mut cookie_headers = headers.get_all(header::COOKIE).iter();
    let Some(cookie_header) = cookie_headers.next() else {
        return Ok(body_token);
    };
    if cookie_headers.next().is_some() {
        return Err(refuse());
    }
    let cookie_header = cookie_header.to_str().map_err(|_| refuse())?;
    let mut refresh = None;
    let mut legacy = None;
    for pair in cookie_header.split(';') {
        let Some((name, value)) = pair.split_once('=') else {
            if [REFRESH_COOKIE_NAME, LEGACY_REFRESH_COOKIE_NAME].contains(&pair.trim()) {
                return Err(refuse());
            }
            continue;
        };
        let credential = match name.trim() {
            REFRESH_COOKIE_NAME => &mut refresh,
            LEGACY_REFRESH_COOKIE_NAME => &mut legacy,
            _ => continue,
        };
        if credential.replace(value.trim()).is_some() {
            return Err(refuse());
        }
    }
    let Some(refresh) = refresh.or(legacy) else {
        return Ok(body_token);
    };
    if headers.contains_key(header::AUTHORIZATION)
        || body_token.is_some()
        || !has_exact_header(headers, "origin", expected_origin)
        || !has_exact_header(headers, "sec-fetch-site", "same-origin")
    {
        return Err(refuse());
    }
    Ok((!refresh.is_empty()).then(|| refresh.to_owned()))
}

fn has_exact_header(headers: &HeaderMap, name: &'static str, expected: &str) -> bool {
    let mut values = headers.get_all(name).iter();
    values.next().and_then(|value| value.to_str().ok()) == Some(expected) && values.next().is_none()
}

/// Build a `Set-Cookie` header that stores the refresh token for the web
/// transport.
///
/// Origin and Fetch Metadata are checked before consuming an ambient refresh
/// credential; these cookie attributes provide independent browser safeguards.
pub(crate) fn refresh_set_cookie(token: &str, max_age_secs: i64) -> Option<HeaderValue> {
    let max_age = max_age_secs.max(0);
    let cookie = format!(
        "{REFRESH_COOKIE_NAME}={token}; HttpOnly; SameSite=Strict; Path={REFRESH_COOKIE_PATH}; Max-Age={max_age}; Secure"
    );
    HeaderValue::from_str(&cookie).ok()
}

/// Build a `Set-Cookie` header that CLEARS the refresh cookie (logout): same
/// name/path/attributes with `Max-Age=0` so the browser drops it immediately.
pub(crate) fn refresh_clear_cookie() -> Option<HeaderValue> {
    refresh_set_cookie("", 0)
}

/// Turn a minted token pair into a transport-appropriate response.
///
/// Cookie transport (web): emit the refresh token as an HttpOnly `Set-Cookie`
/// and NULL the body `refresh_token` so it never reaches web JS. Body transport
/// (mobile): leave the refresh token in the JSON body and set no cookie. The
/// access token stays in the body in both cases.
#[cfg(feature = "dev-auth")]
pub(crate) fn token_pair_response(tokens: IssuedTokenPair, headers: &HeaderMap) -> Response {
    token_pair_response_with_profile(tokens, headers, None)
}

pub(crate) fn token_pair_response_with_profile(
    tokens: IssuedTokenPair,
    headers: &HeaderMap,
    profile: Option<crate::dto::token::PasskeyProfile>,
) -> Response {
    if wants_cookie_transport(headers) {
        let max_age = (tokens.refresh_expires_at - OffsetDateTime::now_utc()).whole_seconds();
        let body = TokenPairResponse {
            access_token: tokens.access_token,
            refresh_token: None,
            token_type: "Bearer",
            refresh_expires_at: tokens.refresh_expires_at,
            requires_passkey_setup: false,
            privacy_consent_accepted: tokens.privacy_consent_accepted,
            passkey_profile: profile,
        };
        with_refresh_cookie(
            Json(body).into_response(),
            refresh_set_cookie(&tokens.refresh_token, max_age),
        )
    } else {
        let mut body = tokens.into_response();
        body.passkey_profile = profile;
        Json(body).into_response()
    }
}

/// Append a `Set-Cookie` header to a response when one was built.
pub(crate) fn with_refresh_cookie(mut response: Response, cookie: Option<HeaderValue>) -> Response {
    if let Some(cookie) = cookie {
        response.headers_mut().append(header::SET_COOKIE, cookie);
        response.headers_mut().append(
            header::SET_COOKIE,
            HeaderValue::from_static(LEGACY_REFRESH_CLEAR_COOKIE),
        );
    }
    response
}

#[cfg(test)]
#[path = "cookies_security_tests.rs"]
mod security_tests;
