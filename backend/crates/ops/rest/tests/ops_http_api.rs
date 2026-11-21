// SPDX-License-Identifier: LicenseRef-Proprietary
use std::time::Duration;

use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use console_ops_rest::router;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use serde_json::{Value, json};
use time::OffsetDateTime;
use tower::ServiceExt;

mod support;
use support::{
    AUD, EXPIRED_EMAIL, ISSUER, JwtSigner, OPERATOR_EMAIL, ORIGIN, OTHER_AUD, READ_HOME_ONLY_EMAIL,
    UNKNOWN_EMAIL, b64url, make_state,
};

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

#[tokio::test]
async fn authorized_operator_reads_all_eight_json_routes_with_no_store_and_no_cors() -> TestResult {
    let signer = JwtSigner::generate()?;
    let (state, _, _, _) = make_state(&signer).await?;
    let app = router(state, Some(Duration::from_secs(5)));
    let jwt = signer.sign(OPERATOR_EMAIL, AUD, ISSUER, 300, None)?;

    for path in [
        "/api/ops/v1/me",
        "/api/ops/v1/home",
        "/api/ops/v1/alerts",
        "/api/ops/v1/alerts/HighLatency%C3%97",
        "/api/ops/v1/silences",
        "/api/ops/v1/running",
        "/api/ops/v1/running/jobs",
        "/api/ops/v1/sources",
    ] {
        let req = Request::builder()
            .uri(path)
            .header("Cf-Access-Jwt-Assertion", &jwt)
            .body(Body::empty())?;
        let (status, headers, body) = send(&app, req).await?;
        assert_eq!(status, StatusCode::OK, "{path}: {body}");
        assert_eq!(headers[header::CACHE_CONTROL], "no-store", "{path}");
        assert!(!headers.contains_key(header::SET_COOKIE), "{path}");
        for name in headers.keys() {
            assert!(
                !name.as_str().starts_with("access-control-"),
                "{path}: {name}"
            );
        }
        if path == "/api/ops/v1/home" {
            let s = body["worklist"][0]["since"]["value"]
                .as_str()
                .ok_or("home worklist since.value must be RFC 3339 string")?;
            assert!(s.ends_with('Z'), "{path}: {s}");
        } else if path == "/api/ops/v1/alerts" {
            let s = body["groups"][0]["since"]["value"]
                .as_str()
                .ok_or("alerts since.value must be RFC 3339 string")?;
            assert!(s.ends_with('Z'), "{path}: {s}");
        } else if path == "/api/ops/v1/alerts/HighLatency%C3%97" {
            let s = body["group"]["since"]["value"]
                .as_str()
                .ok_or("alert detail since.value must be RFC 3339 string")?;
            assert!(s.ends_with('Z'), "{path}: {s}");
            let ms = body["group"]["members"][0]["since"]["value"]
                .as_str()
                .ok_or("alert member since.value must be RFC 3339 string")?;
            assert!(ms.ends_with('Z'), "{path}: {ms}");
        }
    }

    // /me omits ungranted actions for limited operator.
    let limited_jwt = signer.sign(READ_HOME_ONLY_EMAIL, AUD, ISSUER, 300, None)?;
    let req = Request::builder()
        .uri("/api/ops/v1/me")
        .header("Cf-Access-Jwt-Assertion", &limited_jwt)
        .body(Body::empty())?;
    let (status, _, body) = send(&app, req).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["allowed_actions"], json!(["read.me", "read.home"]));
    Ok(())
}

#[tokio::test]
async fn jwt_and_cedar_refusals_return_distinct_contract_codes() -> TestResult {
    let signer = JwtSigner::generate()?;
    let other_signer = JwtSigner::generate()?;
    let (state, _, _, _) = make_state(&signer).await?;
    let app = router(state, None);

    // 1. Missing header -> OPS_ACCESS_JWT_MISSING
    let (s, h, b) = send(&app, Request::get("/api/ops/v1/home").body(Body::empty())?).await?;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(h[header::CACHE_CONTROL], "no-store");
    assert_eq!(b["code"], "OPS_ACCESS_JWT_MISSING");
    assert!(b["support_ref"].as_str().is_some_and(|v| !v.is_empty()));

    // 2. Cookie CF_Authorization is ignored when header is absent.
    let valid_jwt = signer.sign(OPERATOR_EMAIL, AUD, ISSUER, 300, None)?;
    let (s, _, b) = send(
        &app,
        Request::get("/api/ops/v1/home")
            .header(header::COOKIE, format!("CF_Authorization={valid_jwt}"))
            .body(Body::empty())?,
    )
    .await?;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(b["code"], "OPS_ACCESS_JWT_MISSING");

    // 3. Header wins over cookie naming another identity.
    let limited_jwt = signer.sign(READ_HOME_ONLY_EMAIL, AUD, ISSUER, 300, None)?;
    let (s, _, b) = send(
        &app,
        Request::get("/api/ops/v1/alerts")
            .header("Cf-Access-Jwt-Assertion", &limited_jwt)
            .header(header::COOKIE, format!("CF_Authorization={valid_jwt}"))
            .body(Body::empty())?,
    )
    .await?;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert_eq!(b["code"], "OPS_ACTION_DENIED");

    // 4. Invalid signature / expired / future nbf / wrong iss / HS256 / alg:none -> OPS_ACCESS_JWT_INVALID
    let bad_sig = other_signer.sign(OPERATOR_EMAIL, AUD, ISSUER, 300, None)?;
    let expired = signer.sign(OPERATOR_EMAIL, AUD, ISSUER, -60, None)?;
    let future_nbf = signer.sign(OPERATOR_EMAIL, AUD, ISSUER, 300, Some(60))?;
    let wrong_iss = signer.sign(OPERATOR_EMAIL, AUD, "https://other.invalid", 300, None)?;
    let hs256 = encode(
        &Header {
            alg: Algorithm::HS256,
            kid: Some("kid-1".into()),
            ..Default::default()
        },
        &json!({"email": OPERATOR_EMAIL, "aud": AUD, "iss": ISSUER, "exp": OffsetDateTime::now_utc().unix_timestamp() + 300}),
        &EncodingKey::from_secret(b"secret"),
    )?;
    let alg_none = format!(
        "{}.{}.",
        b64url(br#"{"alg":"none","typ":"JWT","kid":"kid-1"}"#),
        b64url(
            format!(
                r#"{{"email":"{OPERATOR_EMAIL}","aud":"{AUD}","iss":"{ISSUER}","exp":{}}}"#,
                OffsetDateTime::now_utc().unix_timestamp() + 300
            )
            .as_bytes()
        ),
    );
    for bad in [bad_sig, expired, future_nbf, wrong_iss, hs256, alg_none] {
        let (s, _, b) = send(
            &app,
            Request::get("/api/ops/v1/home")
                .header("Cf-Access-Jwt-Assertion", bad)
                .body(Body::empty())?,
        )
        .await?;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        assert_eq!(b["code"], "OPS_ACCESS_JWT_INVALID");
    }

    // 5. Valid JWT with preview aud -> OPS_ACCESS_AUD_MISMATCH
    let preview_jwt = signer.sign(OPERATOR_EMAIL, OTHER_AUD, ISSUER, 300, None)?;
    let (s, _, b) = send(
        &app,
        Request::get("/api/ops/v1/home")
            .header("Cf-Access-Jwt-Assertion", preview_jwt)
            .body(Body::empty())?,
    )
    .await?;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(b["code"], "OPS_ACCESS_AUD_MISMATCH");

    // 6. Unknown operator / expired grant / action denied
    for (email, expected_code) in [
        (UNKNOWN_EMAIL, "OPS_NOT_OPERATOR"),
        (EXPIRED_EMAIL, "OPS_GRANT_NOT_LIVE"),
    ] {
        let tok = signer.sign(email, AUD, ISSUER, 300, None)?;
        let (s, _, b) = send(
            &app,
            Request::get("/api/ops/v1/home")
                .header("Cf-Access-Jwt-Assertion", tok)
                .body(Body::empty())?,
        )
        .await?;
        assert_eq!(s, StatusCode::FORBIDDEN);
        assert_eq!(b["code"], expected_code);
    }
    Ok(())
}

#[tokio::test]
async fn origin_guard_refuses_non_get_without_matching_origin_and_same_origin_and_emits_zero_cors()
-> TestResult {
    let signer = JwtSigner::generate()?;
    let (state, _, _, _) = make_state(&signer).await?;
    let app = router(state, None);

    for method in [Method::POST, Method::PUT, Method::DELETE, Method::OPTIONS] {
        // Missing Origin / wrong Origin / missing Sec-Fetch-Site -> 403 origin_refused
        let (s, h, b) = send(
            &app,
            Request::builder()
                .method(method.clone())
                .uri("/api/ops/v1/home")
                .header(header::ORIGIN, "https://perses.ops.example.invalid")
                .header("Sec-Fetch-Site", "same-site")
                .body(Body::empty())?,
        )
        .await?;
        assert_eq!(s, StatusCode::FORBIDDEN, "{method}");
        assert_eq!(b["code"], "origin_refused", "{method}");
        assert_eq!(h[header::CACHE_CONTROL], "no-store", "{method}");
        for name in h.keys() {
            assert!(
                !name.as_str().starts_with("access-control-"),
                "{method}: {name}"
            );
        }

        // Valid Origin + Sec-Fetch-Site: same-origin falls through to 405 on Stage-0 GET routes.
        let (s, h, _) = send(
            &app,
            Request::builder()
                .method(method.clone())
                .uri("/api/ops/v1/home")
                .header(header::ORIGIN, ORIGIN)
                .header("Sec-Fetch-Site", "same-origin")
                .body(Body::empty())?,
        )
        .await?;
        assert_eq!(s, StatusCode::METHOD_NOT_ALLOWED, "{method}");
        assert_eq!(h[header::CACHE_CONTROL], "no-store", "{method}");
    }
    Ok(())
}
