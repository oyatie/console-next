//! The reason-code routes fail closed before any handler or query runs: no
//! verifier is 503, no or a bad bearer is 401, on every route and method.
//! The authenticated paths are proven in the adapter's DB tests.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::body::Body;
use console_platform_auth::{JwtSettings, JwtVerifier};
use console_settings_adapter_postgres::PgSettingsStore;
use console_settings_rest::{REASON_CODES_ROUTE_PATHS, SettingsRestState, router};
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

fn state(verifier: bool) -> SettingsRestState {
    // Never connected: every request below is refused before a query.
    let pool = PgPoolOptions::new()
        .connect_lazy("postgres://reason-codes-rest-test.invalid/none")
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

const REQUESTS: &[(&str, &str)] = &[
    ("GET", "/api/v1/reason-codes?domain=period_unlock"),
    ("POST", "/api/v1/reason-codes"),
    ("PATCH", "/api/v1/reason-codes/period_unlock/OTHER"),
    ("GET", "/api/v1/reason-codes/stats"),
];

async fn status(
    state: SettingsRestState,
    method: &str,
    uri: &str,
    bearer: Option<&str>,
) -> StatusCode {
    let mut request = Request::builder()
        .method(Method::from_bytes(method.as_bytes()).unwrap())
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = bearer {
        request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let body =
        Body::from(r#"{"domain": "period_unlock", "label_ko": "x", "requires_note": false}"#);
    router(state)
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap()
        .status()
}

#[test]
fn route_paths_name_every_mounted_route() {
    assert_eq!(
        REASON_CODES_ROUTE_PATHS,
        &[
            "/api/v1/reason-codes",
            "/api/v1/reason-codes/{domain}/{code}",
            "/api/v1/reason-codes/stats"
        ]
    );
}

#[tokio::test]
async fn without_a_verifier_every_route_is_unavailable() {
    for (method, uri) in REQUESTS {
        let got = status(state(false), method, uri, None).await;
        assert_eq!(got, StatusCode::SERVICE_UNAVAILABLE, "{method} {uri}");
    }
}

#[tokio::test]
async fn without_a_valid_bearer_every_route_is_unauthorized() {
    for (method, uri) in REQUESTS {
        for bearer in [None, Some("not-a-jwt")] {
            let got = status(state(true), method, uri, bearer).await;
            assert_eq!(got, StatusCode::UNAUTHORIZED, "{method} {uri} {bearer:?}");
        }
    }
}
