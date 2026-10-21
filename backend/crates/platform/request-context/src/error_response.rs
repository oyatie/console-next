use axum::Json;
use axum::response::{IntoResponse, Response};
use console_kernel_core::ErrorKind;
use http::StatusCode;

use crate::RequestContextError;

pub(super) fn error_response(status: StatusCode, message: &str) -> Response {
    let code = match status {
        StatusCode::UNAUTHORIZED => "unauthorized",
        StatusCode::FORBIDDEN => "forbidden",
        StatusCode::SERVICE_UNAVAILABLE => "unavailable",
        _ => "internal",
    };
    (
        status,
        Json(serde_json::json!({"error": {"code": code, "message": message}})),
    )
        .into_response()
}

pub(super) fn error_response_for(err: &RequestContextError) -> Response {
    let status = match err {
        RequestContextError::VerifierUnavailable => StatusCode::SERVICE_UNAVAILABLE,
        RequestContextError::BranchScope(_) | RequestContextError::EffectivePolicy(_) => {
            StatusCode::INTERNAL_SERVER_ERROR
        }
        RequestContextError::AccessScope(error) if error.kind == ErrorKind::Forbidden => {
            StatusCode::FORBIDDEN
        }
        RequestContextError::AccessScope(_) => StatusCode::INTERNAL_SERVER_ERROR,
        // A valid token presented to the wrong tier is an authorization failure,
        // not an authentication one: the caller IS authenticated, just not for
        // this route. 403 keeps it distinct from "no/!invalid token" (401).
        RequestContextError::WrongTokenTier => StatusCode::FORBIDDEN,
        _ => StatusCode::UNAUTHORIZED,
    };
    error_response(status, &err.to_string())
}

#[cfg(test)]
mod tests {
    use axum::body::{Body, to_bytes};
    use axum::http::{Request, StatusCode, header};
    use axum::routing::get;
    use axum::{Router, response::Response};
    use console_kernel_core::KernelError;
    use console_platform_auth::{JwtSettings, JwtVerifier};
    use serde_json::{Value, json};
    use sqlx::postgres::PgPoolOptions;
    use time::Duration;
    use tower::ServiceExt;

    use crate::{
        RequestContextError, error_response_for, with_platform_context, with_request_context,
    };

    async fn assert_refusal(response: Response, status: StatusCode, code: &str, message: &str) {
        assert_eq!(response.status(), status);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
        assert!(!response.headers().contains_key(header::RETRY_AFTER));
        let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body, json!({"error": {"code": code, "message": message}}));
    }

    #[tokio::test]
    async fn middleware_refusals_have_stable_json_codes_and_messages() {
        for (error, status, code) in [
            (
                RequestContextError::MissingOrg,
                StatusCode::UNAUTHORIZED,
                "unauthorized",
            ),
            (
                RequestContextError::MissingBearer,
                StatusCode::UNAUTHORIZED,
                "unauthorized",
            ),
            (
                RequestContextError::InvalidToken,
                StatusCode::UNAUTHORIZED,
                "unauthorized",
            ),
            (
                RequestContextError::InvalidClaim("unknown role"),
                StatusCode::UNAUTHORIZED,
                "unauthorized",
            ),
            (
                RequestContextError::VerifierUnavailable,
                StatusCode::SERVICE_UNAVAILABLE,
                "unavailable",
            ),
            (
                RequestContextError::BranchScope("store unavailable".into()),
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
            ),
            (
                RequestContextError::EffectivePolicy("store unavailable".into()),
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
            ),
            (
                RequestContextError::AccessScope(KernelError::forbidden("not permitted")),
                StatusCode::FORBIDDEN,
                "forbidden",
            ),
            (
                RequestContextError::AccessScope(KernelError::internal("missing scope")),
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
            ),
            (
                RequestContextError::WrongTokenTier,
                StatusCode::FORBIDDEN,
                "forbidden",
            ),
        ] {
            assert_refusal(error_response_for(&error), status, code, &error.to_string()).await;
        }
    }

    #[tokio::test]
    async fn disabled_verifier_refuses_both_middleware_tiers_with_json() {
        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://localhost/refusals")
            .unwrap();
        let router = Router::new().route("/", get(|| async { "protected" }));
        for app in [
            with_request_context(router.clone(), None, pool.clone()),
            with_platform_context(router, None, pool),
        ] {
            let response = app.oneshot(Request::new(Body::empty())).await.unwrap();
            assert_refusal(
                response,
                StatusCode::SERVICE_UNAVAILABLE,
                "unavailable",
                "JWT verification is not configured",
            )
            .await;
        }
    }

    #[tokio::test]
    async fn refresh_cookie_alone_cannot_authenticate_either_api_tier() {
        let verifier = JwtVerifier::from_es256_public_pem(
            JwtSettings {
                issuer: "refusal-tests".into(),
                audience: "console-api".into(),
                access_token_ttl: Duration::minutes(5),
            },
            b"-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAErqbm74Mq9tVgRbBqU5mR9tf5DNh2\nXaWyKcVK/xCY0irKLUe+21rfAc2RhmwzXGvn/C7nk0oR4ptSGkYDJp6TLg==\n-----END PUBLIC KEY-----\n",
        ).unwrap();
        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://localhost/refusals")
            .unwrap();
        let router = Router::new().route("/", get(|| async { "protected" }));
        for app in [
            with_request_context(router.clone(), Some(verifier.clone()), pool.clone()),
            with_platform_context(router, Some(verifier), pool),
        ] {
            let request = Request::builder()
                .uri("/")
                .header(header::COOKIE, "console_refresh=ambient-token")
                .body(Body::empty())
                .unwrap();
            let response = app.oneshot(request).await.unwrap();
            assert_refusal(
                response,
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "missing or malformed bearer token",
            )
            .await;
        }
    }
}
