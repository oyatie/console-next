#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "support/http.rs"]
mod support;

use axum::body::{Body, to_bytes};
use console_kernel_core::OrgId;
use console_platform_auth::RefreshTokenStore;
use console_platform_test_support::{runtime_role_pool, seed_branch, seed_user};
use http::{HeaderMap, HeaderValue, Request, StatusCode, header};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use uuid::Uuid;

const ORIGIN: &str = "https://auth.example.com";
const REFRESH: &str = "/api/v1/auth/token/refresh";
const LOGOUT: &str = "/api/v1/auth/logout";

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn refresh_and_logout_cookie_refusals_leave_sessions_unchanged(pool: PgPool) {
    let branch = seed_branch(&pool, "Cookie refusal", "Cookie refusal").await;
    let user = seed_user(&pool, "Cookie refusal", "MECHANIC", branch).await;
    let issued = RefreshTokenStore
        .issue_family(
            &pool,
            *user.as_uuid(),
            OrgId::one(),
            OffsetDateTime::now_utc(),
            Duration::hours(1),
        )
        .await
        .unwrap();
    let runtime = runtime_role_pool(&pool).await;
    let service = console_app::build_router(support::app_state(
        runtime.clone(),
        runtime,
        &support::keys(),
    ));
    let before = session_snapshot(&pool, issued.family_id).await;
    for path in [REFRESH, LOGOUT] {
        for case in [
            "missing_origin",
            "sibling_origin",
            "wrong_scheme",
            "null_origin",
            "missing_fetch_site",
            "same_site",
            "cross_site",
            "foreign_cross_site",
            "fetch_none",
            "mixed_bearer",
            "mixed_body",
            "empty_body",
            "duplicate_cookie",
            "repeated_cookie_header",
            "repeated_origin",
            "repeated_fetch_site",
            "nontext_origin",
        ] {
            let (headers, body) = refused_request(case, issued.token.as_str());
            let response = post(&service, path, headers, body).await;
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{path}: {case}");
            assert!(!response.headers().contains_key(header::SET_COOKIE));
            let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            let error: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(error["error"]["code"], "forbidden", "{path}: {case}");
            assert_eq!(
                session_snapshot(&pool, issued.family_id).await,
                before,
                "{path}: {case} changed token, family, or audit state"
            );
        }
    }

    // All refusals leave the original token usable for a real rotation/logout.
    let response = post(
        &service,
        REFRESH,
        cookie_headers(issued.token.as_str()),
        json!({}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let rotated = response.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .strip_prefix("__Host-console_refresh=")
        .unwrap()
        .to_owned();
    assert_ne!(rotated, issued.token.as_str());
    let response = post(&service, LOGOUT, cookie_headers(&rotated), json!({})).await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let revoked: bool = sqlx::query_scalar(
        "SELECT revoked_at IS NOT NULL FROM auth_refresh_token_families WHERE id=$1",
    )
    .bind(issued.family_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(revoked);
}

fn cookie_headers(token: &str) -> HeaderMap {
    HeaderMap::from_iter([
        (
            header::COOKIE,
            HeaderValue::from_str(&format!("__Host-console_refresh={token}")).unwrap(),
        ),
        (header::ORIGIN, HeaderValue::from_static(ORIGIN)),
        (
            header::HeaderName::from_static("sec-fetch-site"),
            HeaderValue::from_static("same-origin"),
        ),
        (
            header::HeaderName::from_static("x-auth-transport"),
            HeaderValue::from_static("cookie"),
        ),
    ])
}

fn refused_request(case: &str, token: &str) -> (HeaderMap, Value) {
    let mut headers = cookie_headers(token);
    let mut body = json!({});
    match case {
        "missing_origin" => {
            headers.remove(header::ORIGIN);
        }
        "sibling_origin" => {
            headers.insert(
                header::ORIGIN,
                HeaderValue::from_static("https://sibling.example.com"),
            );
        }
        "wrong_scheme" => {
            headers.insert(
                header::ORIGIN,
                HeaderValue::from_static("http://auth.example.com"),
            );
        }
        "null_origin" => {
            headers.insert(header::ORIGIN, HeaderValue::from_static("null"));
        }
        "missing_fetch_site" => {
            headers.remove("sec-fetch-site");
        }
        "same_site" => {
            headers.insert("sec-fetch-site", HeaderValue::from_static("same-site"));
        }
        "cross_site" => {
            headers.insert("sec-fetch-site", HeaderValue::from_static("cross-site"));
        }
        "foreign_cross_site" => {
            headers.insert(
                header::ORIGIN,
                HeaderValue::from_static("https://foreign.example.test"),
            );
            headers.insert("sec-fetch-site", HeaderValue::from_static("cross-site"));
        }
        "fetch_none" => {
            headers.insert("sec-fetch-site", HeaderValue::from_static("none"));
        }
        "mixed_bearer" => {
            headers.insert(
                header::AUTHORIZATION,
                HeaderValue::from_static("Bearer another-credential"),
            );
        }
        "mixed_body" => {
            body = json!({"refresh_token": token});
        }
        "empty_body" => {
            body = json!({"refresh_token": ""});
        }
        "duplicate_cookie" => {
            headers.insert(
                header::COOKIE,
                HeaderValue::from_str(&format!(
                    "__Host-console_refresh={token}; __Host-console_refresh={token}"
                ))
                .unwrap(),
            );
        }
        "repeated_cookie_header" => {
            headers.append(header::COOKIE, HeaderValue::from_static("other=value"));
        }
        "repeated_origin" => {
            headers.append(header::ORIGIN, HeaderValue::from_static(ORIGIN));
        }
        "repeated_fetch_site" => {
            headers.append("sec-fetch-site", HeaderValue::from_static("same-origin"));
        }
        "nontext_origin" => {
            headers.insert(header::ORIGIN, HeaderValue::from_bytes(b"\xff").unwrap());
        }
        _ => panic!("unknown refusal case {case}"),
    }
    (headers, body)
}

async fn post(
    service: &axum::Router,
    path: &str,
    headers: HeaderMap,
    body: Value,
) -> http::Response<Body> {
    let mut request = Request::builder()
        .method("POST")
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    request.headers_mut().extend(headers);
    service.clone().oneshot(request).await.unwrap()
}

async fn session_snapshot(pool: &PgPool, family: Uuid) -> Value {
    sqlx::query_scalar(
        "SELECT jsonb_build_object(\
         'tokens', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM auth_refresh_tokens t WHERE family_id=$1), \
         'family', (SELECT to_jsonb(f) FROM auth_refresh_token_families f WHERE id=$1), \
         'audits', (SELECT count(*) FROM audit_events))",
    )
    .bind(family)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn legacy_refresh_migrates_to_host_cookie_without_losing_the_session(pool: PgPool) {
    let branch = seed_branch(&pool, "Cookie migration", "Cookie migration").await;
    let user = seed_user(&pool, "Cookie migration", "MECHANIC", branch).await;
    let issued = RefreshTokenStore
        .issue_family(
            &pool,
            *user.as_uuid(),
            OrgId::one(),
            OffsetDateTime::now_utc(),
            Duration::hours(1),
        )
        .await
        .unwrap();
    let runtime = runtime_role_pool(&pool).await;
    let service = console_app::build_router(support::app_state(
        runtime.clone(),
        runtime,
        &support::keys(),
    ));
    let mut headers = cookie_headers(issued.token.as_str());
    headers.insert(
        header::COOKIE,
        HeaderValue::from_str(&format!("console_refresh={}", issued.token.as_str())).unwrap(),
    );
    let before = session_snapshot(&pool, issued.family_id).await;
    let mut foreign = headers.clone();
    foreign.insert(
        header::ORIGIN,
        HeaderValue::from_static("https://foreign.example.test"),
    );
    foreign.insert("sec-fetch-site", HeaderValue::from_static("cross-site"));
    assert_eq!(
        post(&service, REFRESH, foreign, json!({})).await.status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(session_snapshot(&pool, issued.family_id).await, before);
    let response = post(&service, REFRESH, headers, json!({})).await;
    assert_eq!(response.status(), StatusCode::OK);
    let cookies: Vec<_> = response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|value| value.to_str().unwrap())
        .collect();
    let host = cookies
        .iter()
        .find(|cookie| cookie.starts_with("__Host-console_refresh="))
        .unwrap();
    assert!(host.contains("; Secure"));
    assert!(host.contains("; Path=/;"));
    assert!(!host.contains("Domain="));
    assert!(cookies.contains(
        &"console_refresh=; HttpOnly; SameSite=Strict; Path=/api/v1/auth; Max-Age=0; Secure"
    ));
    let rotated = host
        .split(';')
        .next()
        .unwrap()
        .strip_prefix("__Host-console_refresh=")
        .unwrap()
        .to_owned();
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert!(body["refresh_token"].is_null());
    assert!(body["access_token"].is_string());
    assert_eq!(
        post(&service, LOGOUT, cookie_headers(&rotated), json!({}))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
}
