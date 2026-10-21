use super::*;

pub(super) async fn post_cookie_refresh(app: axum::Router, cookie: &str) -> http::Response<Body> {
    app.oneshot(
        Request::builder()
            .method("POST")
            .uri("/api/v1/auth/token/refresh")
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-auth-transport", "cookie")
            .header(header::ORIGIN, "https://auth.example.com")
            .header("sec-fetch-site", "same-origin")
            .header(header::COOKIE, cookie)
            .body(Body::from("{}"))
            .unwrap(),
    )
    .await
    .unwrap()
}
