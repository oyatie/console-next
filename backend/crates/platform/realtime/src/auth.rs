//! Bearer resolution shared by the WS and SSE handlers.

use std::sync::Arc;
use std::time::Duration;

use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use console_kernel_core::{ErrorKind, ErrorType};
use console_platform_auth::JwtVerifier;
use console_platform_authz::Principal;
use console_platform_request_context::RequestContextError;
use serde::Serialize;

use crate::{PgRealtimeHub, RealtimePrincipal};

#[derive(Debug, Clone)]
pub struct RealtimeRestState {
    pub(crate) hub: Arc<PgRealtimeHub>,
    pub(crate) jwt_verifier: Option<JwtVerifier>,
    /// `realtime.heartbeat_interval`: SSE comment / WS ping cadence, under
    /// the edge's idle timeouts (Cloudflare 100 s, Traefik 60 s).
    pub(crate) heartbeat_interval: Duration,
    /// `realtime.session_recheck_interval`: how stale a stream's reader
    /// principal may be before the next change frame re-resolves it.
    pub(crate) session_recheck_interval: Duration,
}

impl RealtimeRestState {
    #[must_use]
    pub fn new(hub: Arc<PgRealtimeHub>, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self {
            hub,
            jwt_verifier,
            heartbeat_interval: Duration::from_secs(25),
            session_recheck_interval: Duration::from_secs(60),
        }
    }

    /// INTEG sets both from the settings registry (SET-RT).
    #[must_use]
    pub fn with_intervals(mut self, heartbeat: Duration, session_recheck: Duration) -> Self {
        self.heartbeat_interval = heartbeat;
        self.session_recheck_interval = session_recheck;
        self
    }

    #[must_use]
    pub fn hub(&self) -> &Arc<PgRealtimeHub> {
        &self.hub
    }
}

pub(crate) async fn principal_from_token(
    state: &RealtimeRestState,
    token: &str,
) -> Result<RealtimePrincipal, RealtimeApiError> {
    let principal = reader_from_token(state, token).await?;
    Ok(RealtimePrincipal {
        user_id: principal.user_id,
        branch_scope: principal.branch_scope,
        org_id: principal.org_id,
    })
}

/// The full authorization principal, as REST resolves it per request: the
/// change stream's read filter decides with it.
pub(crate) async fn reader_from_token(
    state: &RealtimeRestState,
    token: &str,
) -> Result<Principal, RealtimeApiError> {
    let verifier = state.jwt_verifier.as_ref().ok_or_else(|| {
        RealtimeApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "JWT verification is not configured for realtime",
        )
    })?;
    let pool = state.hub.pool.as_ref().ok_or_else(|| {
        RealtimeApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "realtime database is not configured",
        )
    })?;
    console_platform_request_context::resolve_principal_from_bearer_token(verifier, pool, token)
        .await
        .map_err(realtime_error_from_request_context)
}

pub(crate) fn bearer_token(headers: &HeaderMap) -> Result<&str, RealtimeApiError> {
    if let Some(token) = authorization_bearer_token(headers)? {
        return Ok(token);
    }
    if let Some(token) = websocket_protocol_bearer_token(headers)? {
        return Ok(token);
    }
    Err(RealtimeApiError::unauthorized("missing bearer token"))
}

pub(crate) fn authorization_bearer_token(
    headers: &HeaderMap,
) -> Result<Option<&str>, RealtimeApiError> {
    let Some(header_value) = headers.get(header::AUTHORIZATION) else {
        return Ok(None);
    };
    let header_value = header_value
        .to_str()
        .map_err(|_| RealtimeApiError::unauthorized("invalid authorization header"))?;
    let token = header_value
        .strip_prefix("Bearer ")
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| {
            RealtimeApiError::unauthorized("authorization header must use Bearer scheme")
        })?;
    Ok(Some(token))
}

pub(crate) fn websocket_protocol_bearer_token(
    headers: &HeaderMap,
) -> Result<Option<&str>, RealtimeApiError> {
    let Some(header_value) = headers.get(header::SEC_WEBSOCKET_PROTOCOL) else {
        return Ok(None);
    };
    let header_value = header_value
        .to_str()
        .map_err(|_| RealtimeApiError::unauthorized("invalid websocket protocol header"))?;
    let protocols = header_value.split(',').map(str::trim).collect::<Vec<_>>();
    let token = protocols
        .windows(2)
        .find_map(|pair| (pair[0] == "bearer" && !pair[1].is_empty()).then_some(pair[1]));
    Ok(token)
}

fn realtime_error_from_request_context(err: RequestContextError) -> RealtimeApiError {
    match err {
        RequestContextError::VerifierUnavailable => RealtimeApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "JWT verification is not configured for realtime",
        ),
        RequestContextError::WrongTokenTier => RealtimeApiError::new(
            StatusCode::FORBIDDEN,
            "forbidden",
            "token tier is not valid for this route",
        ),
        RequestContextError::AccessScope(error) if error.kind == ErrorKind::Forbidden => {
            RealtimeApiError::new(StatusCode::FORBIDDEN, "forbidden", error.message)
        }
        RequestContextError::AccessScope(error) => {
            RealtimeApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", error.message)
        }
        RequestContextError::BranchScope(message)
        | RequestContextError::EffectivePolicy(message) => {
            RealtimeApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", message)
        }
        RequestContextError::MissingOrg => RealtimeApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "no tenant context is bound to the current request",
        ),
        RequestContextError::MissingBearer => {
            RealtimeApiError::unauthorized("missing or malformed bearer token")
        }
        RequestContextError::InvalidToken => RealtimeApiError::unauthorized("invalid bearer token"),
        RequestContextError::InvalidClaim(message) => {
            RealtimeApiError::unauthorized(format!("token claim is invalid: {message}"))
        }
    }
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: ErrorPayload,
}

#[derive(Debug, Serialize)]
struct ErrorPayload {
    code: &'static str,
    message: String,
}

/// 401 for a well-formed access token past its `exp`: the stream's expected end, apart from a refused one.
pub const TOKEN_EXPIRED: &str = "token_expired";

#[derive(Debug)]
pub(crate) struct RealtimeApiError {
    pub(crate) status: StatusCode,
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl RealtimeApiError {
    pub(crate) fn unavailable() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "realtime unavailable",
        )
    }

    pub(crate) fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    pub(crate) fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", message)
    }
}

impl IntoResponse for RealtimeApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            // The HTTP metrics label the request with the code (`error_type`).
            Extension(ErrorType(self.code)),
            Json(ErrorBody {
                error: ErrorPayload {
                    code: self.code,
                    message: self.message,
                },
            }),
        )
            .into_response()
    }
}

#[cfg(test)]
mod auth_tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn bearer_token_accepts_authorization_header() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer native-token"),
        );

        assert_eq!(bearer_token(&headers).expect("token"), "native-token");
    }

    #[test]
    fn bearer_token_accepts_websocket_subprotocol_pair() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_static("bearer, browser-token"),
        );

        assert_eq!(bearer_token(&headers).expect("token"), "browser-token");
    }
}
