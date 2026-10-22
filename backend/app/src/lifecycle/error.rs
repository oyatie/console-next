//! The lifecycle REST error surface (`{ error: { code, message } }`); a coded
//! `KernelError` keeps its code. Split out of `lifecycle.rs` (LOCK lane).

use crate::http::error::{FieldError, MappedKernelError, error_response};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use console_kernel_core::KernelError;
use console_platform_db::DbError;
use console_platform_db::idempotency::{
    IDEMPOTENCY_KEY_HEADER, IDEMPOTENCY_KEY_REUSED, validate_idempotency_key,
};

#[derive(Debug)]
pub struct LifecycleError {
    pub(super) status: StatusCode,
    pub(super) code: &'static str,
    pub(super) message: String,
    pub(super) errors: Option<Vec<FieldError>>,
}

impl LifecycleError {
    pub(super) fn from_kernel(error: KernelError) -> Self {
        let mapped = MappedKernelError::from(error);
        Self {
            status: mapped.status,
            code: mapped.code,
            message: mapped.message,
            errors: mapped.errors,
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
            errors: None,
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
        if value.is_unavailable() {
            return Self::from_kernel(KernelError::unavailable("lifecycle database unavailable"));
        }
        tracing::error!(error = %value, "lifecycle database operation failed");
        Self::internal("lifecycle request failed")
    }
}

impl From<sqlx::Error> for LifecycleError {
    fn from(value: sqlx::Error) -> Self {
        Self::from(DbError::from(value))
    }
}

impl IntoResponse for LifecycleError {
    fn into_response(self) -> Response {
        error_response(self.status, self.code, self.message, self.errors)
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use serde_json::{Value, json};

    async fn body(response: Response) -> Value {
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn lifecycle_field_refusal_reaches_the_error_envelope() {
        let response = LifecycleError::from(
            KernelError::validation("hire date must follow exit")
                .with_code("rehire_date_not_after_exit")
                .with_field("hire_date"),
        )
        .into_response();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let error = body(response).await;
        assert_eq!(error["error"]["code"], "rehire_date_not_after_exit");
        assert_eq!(
            error["error"]["errors"],
            json!([
                { "field": "hire_date", "code": "rehire_date_not_after_exit" }
            ])
        );
    }

    #[tokio::test]
    async fn lifecycle_pool_and_connection_failures_are_503() {
        for failure in [
            sqlx::Error::PoolTimedOut,
            sqlx::Error::Io(std::io::Error::from(std::io::ErrorKind::ConnectionReset)),
        ] {
            let response = LifecycleError::from(failure).into_response();
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(body(response).await["error"]["code"], "unavailable");
        }
    }
}
