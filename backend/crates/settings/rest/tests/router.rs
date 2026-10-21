//! The router fails closed before any handler or query runs: no verifier is
//! 503, no or a bad bearer is 401, on every route and method it mounts. The
//! authenticated paths (resolved values, a change, its audit row, history)
//! are proven in the adapter's DB tests; the persona HTTP tests need a token
//! issuer, which arrives with INTEG's app wiring (INT-6a).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::body::Body;
use console_platform_auth::{JwtSettings, JwtVerifier};
use console_settings_adapter_postgres::PgSettingsStore;
use console_settings_rest::{SETTINGS_ROUTE_PATHS, SettingsRestState, router};
use http::{Method, Request, StatusCode, header};
use sqlx::postgres::PgPoolOptions;
use time::Duration;
use tower::ServiceExt;

/// A throwaway P-256 public key: verification can only fail with it.
const PUBLIC_KEY_PEM: &str = "-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE/VJNoyibP5rweRZ7DJDYbSaC2FvE
zTR0ZMbhn4iS0WKjATDTDFkVvL9sUpxy3ptYVpGHrTUgFObTUgQayuMoaw==
-----END PUBLIC KEY-----
";

const KEY: &str = "approval.delegation.max_days";

fn state(verifier: bool) -> SettingsRestState {
    // Never connected: every request below is refused before a query.
    let pool = PgPoolOptions::new()
        .connect_lazy("postgres://settings-rest-test.invalid/none")
        .unwrap();
    let verifier = verifier.then(|| {
        JwtVerifier::from_es256_public_pem(
            JwtSettings {
                issuer: "console-platform-auth".to_owned(),
                audience: "console-api".to_owned(),
                access_token_ttl: Duration::minutes(15),
            },
            PUBLIC_KEY_PEM.as_bytes(),
        )
        .unwrap()
    });
    SettingsRestState::new(PgSettingsStore::new(pool), verifier)
}

fn requests() -> Vec<(Method, String)> {
    vec![
        (Method::GET, "/api/v1/settings".to_owned()),
        (Method::GET, format!("/api/v1/settings/{KEY}/history")),
        (Method::POST, format!("/api/v1/settings/{KEY}")),
    ]
}

async fn status(
    state: SettingsRestState,
    method: Method,
    uri: &str,
    bearer: Option<&str>,
) -> StatusCode {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = bearer {
        request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let body = Body::from(r#"{"value": 20, "reason_code": "POLICY_REVIEW"}"#);
    router(state)
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap()
        .status()
}

#[test]
fn route_paths_name_every_mounted_route() {
    assert_eq!(
        SETTINGS_ROUTE_PATHS,
        &[
            "/api/v1/settings",
            "/api/v1/settings/{key}",
            "/api/v1/settings/{key}/history"
        ]
    );
}

#[tokio::test]
async fn without_a_verifier_every_route_is_unavailable() {
    for (method, uri) in requests() {
        let got = status(state(false), method.clone(), &uri, None).await;
        assert_eq!(got, StatusCode::SERVICE_UNAVAILABLE, "{method} {uri}");
    }
}

#[tokio::test]
async fn without_a_valid_bearer_every_route_is_unauthorized() {
    for (method, uri) in requests() {
        for bearer in [None, Some("not-a-jwt")] {
            let got = status(state(true), method.clone(), &uri, bearer).await;
            assert_eq!(got, StatusCode::UNAUTHORIZED, "{method} {uri} {bearer:?}");
        }
    }
}
