//! The OTP-enrollment route gate.

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use axum::middleware::Next;
use axum::response::IntoResponse;
use axum::{Json, Router};
use console_platform_auth::JwtVerifier;

/// An OTP enrollment session (verified `enrollment` claim) reaches only
/// [`console_platform_auth_rest::ENROLLMENT_ROUTE_PATHS`]; every other route —
/// tenant, platform, or auth — answers 403 `passkey_required` before any
/// handler runs. Request validation binds the claim to the family's stored OTP
/// source, and the principal resolvers refuse it too (realtime included), so
/// this layer is the uniform error shape, not the only barrier.
pub(crate) fn with_enrollment_gate(router: Router, verifier: Option<JwtVerifier>) -> Router {
    router.layer(axum::middleware::from_fn(
        move |request: Request<Body>, next: Next| {
            let verifier = verifier.clone();
            async move {
                let enrollment = verifier.as_ref().is_some_and(|verifier| {
                    request
                        .headers()
                        .get(header::AUTHORIZATION)
                        .and_then(|value| value.to_str().ok())
                        .and_then(|value| value.strip_prefix("Bearer "))
                        .and_then(|token| verifier.verify_access_token(token.trim()).ok())
                        .is_some_and(|claims| claims.enrollment)
                });
                if enrollment
                    && !console_platform_auth_rest::ENROLLMENT_ROUTE_PATHS
                        .contains(&request.uri().path())
                {
                    return (
                        StatusCode::FORBIDDEN,
                        Json(serde_json::json!({ "error": {
                            "code": "passkey_required",
                            "message": console_platform_request_context::PASSKEY_REQUIRED_MESSAGE,
                        }})),
                    )
                        .into_response();
                }
                next.run(request).await
            }
        },
    ))
}
