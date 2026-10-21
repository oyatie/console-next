//! The signed principal of an attendance request (moved out of lib.rs).

use axum::http::{HeaderMap, StatusCode};
use console_kernel_core::KernelError;
use console_platform_authz::Principal;
use console_platform_request_context::{RequestContextError, resolve_principal};

use crate::{AttendanceRestState, RestError};

pub(crate) async fn principal(
    state: &AttendanceRestState,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let verifier = state.jwt.as_ref().ok_or_else(|| {
        RestError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "JWT verification is not configured",
        )
    })?;
    resolve_principal(verifier, state.store.pool(), headers)
        .await
        .map_err(|e| match e {
            RequestContextError::MissingBearer
            | RequestContextError::InvalidToken
            | RequestContextError::InvalidClaim(_) => RestError::new(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "missing or invalid bearer token",
            ),
            RequestContextError::WrongTokenTier | RequestContextError::AccessScope(_) => {
                RestError::kernel(KernelError::forbidden(
                    "token is not authorized for attendance",
                ))
            }
            RequestContextError::VerifierUnavailable => RestError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "unavailable",
                "JWT verification is not configured",
            ),
            _ => RestError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "request principal could not be resolved",
            ),
        })
}
