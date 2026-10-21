use super::{refresh_set_cookie, select_refresh_credential};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};

const ORIGIN: &str = "https://console.example.com";

fn cookie_request() -> HeaderMap {
    HeaderMap::from_iter([
        (
            header::COOKIE,
            HeaderValue::from_static("console_refresh=cookie-token"),
        ),
        (header::ORIGIN, HeaderValue::from_static(ORIGIN)),
        (
            header::HeaderName::from_static("sec-fetch-site"),
            HeaderValue::from_static("same-origin"),
        ),
    ])
}

fn assert_forbidden(headers: &HeaderMap, body_token: Option<&str>) {
    let error =
        select_refresh_credential(headers, body_token.map(str::to_owned), ORIGIN).unwrap_err();
    assert_eq!(error.status, StatusCode::FORBIDDEN);
    assert_eq!(error.code, "forbidden");
}

#[test]
fn cookies_accept_only_the_exact_configured_origin() {
    let headers = cookie_request();
    assert_eq!(
        select_refresh_credential(&headers, None, ORIGIN).unwrap(),
        Some("cookie-token".into())
    );
    for origin in [
        "https://sibling.example.com",
        "http://console.example.com",
        "https://console.example.com.evil.test",
        "https://console.example.com/",
        "https://console.example.com, https://evil.test",
        "null",
    ] {
        let mut headers = cookie_request();
        headers.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
        assert_forbidden(&headers, None);
    }
}

#[test]
fn cookies_refuse_missing_origin_or_fetch_site() {
    for name in ["origin", "sec-fetch-site"] {
        let mut headers = cookie_request();
        headers.remove(name);
        assert_forbidden(&headers, None);
    }
}

#[test]
fn cookies_refuse_every_fetch_site_except_same_origin() {
    for site in [
        "same-site",
        "cross-site",
        "none",
        "",
        "Same-Origin",
        "same-origin ",
        "same-origin, same-origin",
    ] {
        let mut headers = cookie_request();
        headers.insert("sec-fetch-site", HeaderValue::from_str(site).unwrap());
        assert_forbidden(&headers, None);
    }
}

#[test]
fn cookies_refuse_header_credentials_even_when_malformed() {
    for authorization in ["Bearer header-token", "", "malformed"] {
        let mut headers = cookie_request();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(authorization).unwrap(),
        );
        assert_forbidden(&headers, None);
    }
}

#[test]
fn cookies_refuse_body_credentials_even_when_equal_or_empty() {
    for body in ["cookie-token", "different-token", ""] {
        assert_forbidden(&cookie_request(), Some(body));
    }
}

#[test]
fn cookies_refuse_duplicate_credentials_in_one_header() {
    for cookie in [
        "console_refresh=first; console_refresh=second",
        "console_refresh=same; console_refresh=same",
        "console_refresh=; console_refresh=second",
        "other=value; console_refresh = first ; console_refresh = second",
    ] {
        let mut headers = cookie_request();
        headers.insert(header::COOKIE, HeaderValue::from_str(cookie).unwrap());
        assert_forbidden(&headers, None);
    }
}

#[test]
fn cookies_refuse_repeated_cookie_origin_or_fetch_site_headers() {
    for name in ["cookie", "origin", "sec-fetch-site"] {
        let mut headers = cookie_request();
        let value = headers[name].clone();
        headers.append(
            header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
            value,
        );
        assert_forbidden(&headers, None);
    }
    let mut headers = cookie_request();
    headers.append(header::COOKIE, HeaderValue::from_static("other=value"));
    assert_forbidden(&headers, None);
}

#[test]
fn cookies_refuse_non_text_security_headers() {
    for name in ["cookie", "origin", "sec-fetch-site"] {
        let mut headers = cookie_request();
        headers.insert(
            header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
            HeaderValue::from_bytes(b"\xff").unwrap(),
        );
        assert_forbidden(&headers, None);
    }
}

#[test]
fn cookies_treat_empty_refresh_cookie_as_an_ambient_credential() {
    let mut headers = cookie_request();
    headers.insert(header::COOKIE, HeaderValue::from_static("console_refresh="));
    assert_eq!(
        select_refresh_credential(&headers, None, ORIGIN).unwrap(),
        None
    );
    assert_forbidden(&headers, Some("mobile-token"));
    headers.remove(header::ORIGIN);
    assert_forbidden(&headers, None);
}

#[test]
fn cookies_preserve_mobile_body_transport_and_absent_logout_credential() {
    for headers in [
        HeaderMap::new(),
        HeaderMap::from_iter([(header::COOKIE, HeaderValue::from_static("other=value"))]),
        HeaderMap::from_iter([(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer access-token"),
        )]),
    ] {
        assert_eq!(
            select_refresh_credential(&headers, Some("mobile-token".into()), ORIGIN).unwrap(),
            Some("mobile-token".into())
        );
        assert_eq!(
            select_refresh_credential(&headers, None, ORIGIN).unwrap(),
            None
        );
    }
}

#[test]
fn cookies_keep_refresh_cookie_wire_attributes() {
    assert_eq!(
        refresh_set_cookie("token", 60, true).unwrap(),
        "console_refresh=token; HttpOnly; SameSite=Strict; Path=/api/v1/auth; Max-Age=60; Secure"
    );
    assert_eq!(
        refresh_set_cookie("token", 60, false).unwrap(),
        "console_refresh=token; HttpOnly; SameSite=Strict; Path=/api/v1/auth; Max-Age=60"
    );
}
