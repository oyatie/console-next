// SPDX-License-Identifier: LicenseRef-Proprietary
use std::sync::Arc;

use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use console_ops_rest::router;
use serde_json::Value;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;

mod support;
use support::{AUD, ISSUER, JwtSigner, OPERATOR_EMAIL, ORIGIN, READ_HOME_ONLY_EMAIL, make_state};

type TestResult = Result<(), Box<dyn std::error::Error>>;

async fn send(
    app: &axum::Router,
    req: Request<Body>,
) -> Result<(StatusCode, axum::http::HeaderMap, Value), Box<dyn std::error::Error>> {
    let resp = app.clone().oneshot(req).await?;
    let status = resp.status();
    let headers = resp.headers().clone();
    let bytes = to_bytes(resp.into_body(), 1024 * 1024).await?;
    let val = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or(Value::String(String::from_utf8_lossy(&bytes).into()))
    };
    Ok((status, headers, val))
}

fn assert_flat_error(body: &Value, expected_code: &str, headers: &axum::http::HeaderMap) {
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert!(!headers.contains_key(header::SET_COOKIE));
    for name in headers.keys() {
        assert!(!name.as_str().starts_with("access-control-"), "{name}");
    }
    assert_eq!(body["code"], expected_code, "{body}");
    assert!(
        body["evaluated_at"]
            .as_str()
            .is_some_and(|v| v.ends_with('Z')),
        "{body}"
    );
    assert!(
        body["support_ref"].as_str().is_some_and(|v| !v.is_empty()),
        "{body}"
    );
    assert!(
        body["message"].as_str().is_some_and(|v| !v.is_empty()),
        "{body}"
    );
}

#[tokio::test]
async fn malformed_percent_path_authenticates_first_and_standalone_router_normalizes_404_405()
-> TestResult {
    let signer = JwtSigner::generate()?;
    let (state, _, _, _) = make_state(&signer).await?;
    let app = router(state, None);

    // Unauthenticated /alerts/%FF must return 401 OPS_ACCESS_JWT_MISSING, never 400.
    let (s, h, b) = send(
        &app,
        Request::get("/api/ops/v1/alerts/%FF").body(Body::empty())?,
    )
    .await?;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_flat_error(&b, "OPS_ACCESS_JWT_MISSING", &h);

    // Limited operator lacking read.alerts gets 403 OPS_ACTION_DENIED on /alerts/%FF.
    let limited_jwt = signer.sign(READ_HOME_ONLY_EMAIL, AUD, ISSUER, 300, None)?;
    let (s, h, b) = send(
        &app,
        Request::get("/api/ops/v1/alerts/%FF")
            .header("Cf-Access-Jwt-Assertion", &limited_jwt)
            .body(Body::empty())?,
    )
    .await?;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert_flat_error(&b, "OPS_ACTION_DENIED", &h);

    // Authorized operator gets 404 OPS_NOT_FOUND flat Error JSON on /alerts/%FF.
    let valid_jwt = signer.sign(OPERATOR_EMAIL, AUD, ISSUER, 300, None)?;
    let (s, h, b) = send(
        &app,
        Request::get("/api/ops/v1/alerts/%FF")
            .header("Cf-Access-Jwt-Assertion", &valid_jwt)
            .body(Body::empty())?,
    )
    .await?;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert_flat_error(&b, "OPS_NOT_FOUND", &h);

    // Standalone router normalizes unmatched 404 and 405 into flat Error JSON.
    let (s, h, b) = send(
        &app,
        Request::get("/api/ops/v1/alerts/a/b").body(Body::empty())?,
    )
    .await?;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert_flat_error(&b, "not_found", &h);

    let (s, h, b) = send(
        &app,
        Request::builder()
            .method(Method::POST)
            .uri("/api/ops/v1/home")
            .header(header::ORIGIN, ORIGIN)
            .header("Sec-Fetch-Site", "same-origin")
            .body(Body::empty())?,
    )
    .await?;
    assert_eq!(s, StatusCode::METHOD_NOT_ALLOWED);
    assert_flat_error(&b, "method_not_allowed", &h);
    Ok(())
}

#[tokio::test]
async fn filtered_counts_honor_configured_staleness_and_jwt_rejects_malformed_emails() -> TestResult
{
    let signer = JwtSigner::generate()?;
    let (mut state, _, _, _) = make_state(&signer).await?;
    // Advance clock past 2 * interval_s (120s) without re-evaluating snapshot.
    let stale_now = OffsetDateTime::now_utc() + Duration::seconds(300);
    state = state.with_clock(Arc::new(move || stale_now));
    let app = router(state, None);
    let jwt = signer.sign(OPERATOR_EMAIL, AUD, ISSUER, 600, None)?;

    let (s, _, b) = send(
        &app,
        Request::get("/api/ops/v1/alerts?state=Firing")
            .header("Cf-Access-Jwt-Assertion", &jwt)
            .body(Body::empty())?,
    )
    .await?;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(b["count"]["state"], "Unknown", "{b}");
    assert!(b["count"]["value"].is_null(), "{b}");
    assert_eq!(b["alert_count"]["state"], "Unknown", "{b}");

    let (s, _, b) = send(
        &app,
        Request::get("/api/ops/v1/running?group=app")
            .header("Cf-Access-Jwt-Assertion", &jwt)
            .body(Body::empty())?,
    )
    .await?;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(b["count"]["state"], "Unknown", "{b}");
    assert!(b["count"]["value"].is_null(), "{b}");

    for bad_email in [
        "a b@example.invalid",
        " operator@example.invalid",
        "a@b@example.invalid",
        "@example.invalid",
        "operator@",
    ] {
        let tok = signer.sign(bad_email, AUD, ISSUER, 300, None)?;
        let (s, h, b) = send(
            &app,
            Request::get("/api/ops/v1/home")
                .header("Cf-Access-Jwt-Assertion", tok)
                .body(Body::empty())?,
        )
        .await?;
        assert_eq!(s, StatusCode::UNAUTHORIZED, "{bad_email}");
        assert_flat_error(&b, "OPS_ACCESS_JWT_INVALID", &h);
    }
    Ok(())
}
