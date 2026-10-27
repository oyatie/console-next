use super::*;

/// POST as a WEB client: sends `X-Auth-Transport: cookie` and, optionally, a
/// `Cookie` header carrying `__Host-console_refresh=<token>` (what a browser would replay).
pub(super) async fn post_cookie_mode(
    service: axum::Router,
    uri: &str,
    cookie: Option<&str>,
    body: Value,
) -> http::Response<Body> {
    let mut builder = Request::builder()
        .uri(uri)
        .method("POST")
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-auth-transport", "cookie")
        .header(header::ORIGIN, TEST_ORIGIN)
        .header("sec-fetch-site", "same-origin");
    if let Some(cookie) = cookie {
        builder = builder.header(header::COOKIE, format!("__Host-console_refresh={cookie}"));
    }
    service
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap()
}

/// Same as `post_cookie_mode`, but includes a browser `X-Device-Id` header so
/// tests exercise the per-device auth rate-limit bucket that the web console
/// sends on every request.
pub(super) async fn post_cookie_mode_with_device_id(
    service: axum::Router,
    uri: &str,
    cookie: Option<&str>,
    device_id: &str,
    body: Value,
) -> http::Response<Body> {
    let mut builder = Request::builder()
        .uri(uri)
        .method("POST")
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-auth-transport", "cookie")
        .header(header::ORIGIN, TEST_ORIGIN)
        .header("sec-fetch-site", "same-origin")
        .header("x-device-id", device_id);
    if let Some(cookie) = cookie {
        builder = builder.header(header::COOKIE, format!("__Host-console_refresh={cookie}"));
    }
    service
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap()
}
