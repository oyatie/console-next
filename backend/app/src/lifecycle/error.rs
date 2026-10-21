//! The lifecycle REST error surface (`{ error: { code, message } }`); a coded
//! `KernelError` keeps its code. Split out of `lifecycle.rs` (LOCK lane).

use axum::Json;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use console_kernel_core::{ErrorKind, KernelError};
use console_platform_db::DbError;
use console_platform_db::idempotency::{
    IDEMPOTENCY_KEY_HEADER, IDEMPOTENCY_KEY_REUSED, validate_idempotency_key,
};
use serde_json::json;

#[derive(Debug)]
pub struct LifecycleError {
    pub(super) status: StatusCode,
    pub(super) code: &'static str,
    pub(super) message: String,
}

impl LifecycleError {
    pub(super) fn from_kernel(error: KernelError) -> Self {
        let status = match error.kind {
            ErrorKind::Validation => StatusCode::UNPROCESSABLE_ENTITY,
            ErrorKind::NotFound => StatusCode::NOT_FOUND,
            ErrorKind::Forbidden => StatusCode::FORBIDDEN,
            ErrorKind::Conflict | ErrorKind::InvalidTransition => StatusCode::CONFLICT,
            ErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        };
        let code = error.code.unwrap_or(match error.kind {
            ErrorKind::Validation => "validation",
            ErrorKind::NotFound => "not_found",
            ErrorKind::Forbidden => "forbidden",
            ErrorKind::Conflict => "conflict",
            ErrorKind::InvalidTransition => "invalid_transition",
            ErrorKind::Internal => "internal",
        });
        Self {
            status,
            code,
            message: error.message,
        }
    }

    pub(super) fn validation(message: impl Into<String>) -> Self {
        Self::from_kernel(KernelError::validation(message.into()))
    }

    pub(super) fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal",
            message: message.into(),
        }
    }
}

impl From<KernelError> for LifecycleError {
    fn from(error: KernelError) -> Self {
        Self::from_kernel(error)
    }
}

impl From<DbError> for LifecycleError {
    fn from(value: DbError) -> Self {
        tracing::error!(error = %value, "lifecycle database operation failed");
        Self::internal("lifecycle request failed")
    }
}

impl From<sqlx::Error> for LifecycleError {
    fn from(value: sqlx::Error) -> Self {
        Self::from(DbError::Sqlx(value))
    }
}

impl IntoResponse for LifecycleError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({ "error": { "code": self.code, "message": self.message } })),
        )
            .into_response()
    }
}

/// The optional `Idempotency-Key`: absent is fine, present must be well formed.
pub(in crate::lifecycle) fn optional_idempotency_key(
    headers: &HeaderMap,
) -> Result<Option<String>, LifecycleError> {
    headers
        .get(IDEMPOTENCY_KEY_HEADER)
        .map(|value| {
            validate_idempotency_key(value.to_str().ok()).map_err(LifecycleError::validation)
        })
        .transpose()
}

pub(in crate::lifecycle) fn idempotency_key_reused() -> LifecycleError {
    LifecycleError::from_kernel(KernelError::conflict(IDEMPOTENCY_KEY_REUSED))
}
