//! The JSON error envelope for app-level handlers.

use crate::error::AppError;
use axum::Json;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use console_kernel_core::KernelError;
use serde::Serialize;

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: ErrorPayload,
}

#[derive(Debug, Serialize)]
struct ErrorPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    last_change: Option<serde_json::Value>,
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    errors: Option<Vec<FieldError>>,
}

#[derive(Debug, Serialize)]
pub(crate) struct FieldError {
    field: String,
    code: &'static str,
}

#[derive(Debug)]
pub(crate) struct MappedKernelError {
    pub(crate) status: StatusCode,
    pub(crate) code: &'static str,
    pub(crate) message: String,
    pub(crate) errors: Option<Vec<FieldError>>,
}

impl From<KernelError> for MappedKernelError {
    fn from(error: KernelError) -> Self {
        let code = error.code.unwrap_or(error.kind.code());
        Self {
            status: StatusCode::from_u16(error.status_code())
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            code,
            message: error.message,
            errors: error.field.map(|field| vec![FieldError { field, code }]),
        }
    }
}

// ---------------------------------------------------------------------------
// Prometheus metrics
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub(crate) struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
    errors: Option<Vec<FieldError>>,
}

impl ApiError {
    pub(crate) fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            errors: None,
        }
    }

    pub(crate) fn validation(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNPROCESSABLE_ENTITY, "validation", message)
    }

    pub(crate) fn service_unavailable(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "service_unavailable",
            message,
        )
    }

    pub(crate) fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", message)
    }

    pub(crate) fn from_kernel(error: KernelError) -> Self {
        let mapped = MappedKernelError::from(error);
        Self {
            status: mapped.status,
            code: mapped.code,
            message: mapped.message,
            errors: mapped.errors,
        }
    }

    pub(crate) fn from_app(error: AppError) -> Self {
        tracing::error!(error = %error, "audit api failed");
        match error {
            AppError::Config(message) => Self::service_unavailable(message),
            AppError::DatabaseUnavailable(message) => {
                Self::new(StatusCode::SERVICE_UNAVAILABLE, "unavailable", message)
            }
            AppError::Database(_)
            | AppError::Io(_)
            | AppError::Storage(_)
            | AppError::Realtime(_)
            | AppError::Telemetry(_)
            | AppError::Worker(_)
            | AppError::Internal(_) => Self::internal("internal server error"),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        error_response(self.status, self.code, self.message, self.errors)
    }
}

pub(crate) fn error_response(
    status: StatusCode,
    code: &'static str,
    message: String,
    errors: Option<Vec<FieldError>>,
) -> axum::response::Response {
    (
        status,
        Json(ErrorBody {
            error: ErrorPayload {
                last_change: None,
                code,
                message,
                errors,
            },
        }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, to_bytes};
    use serde_json::Value;

    async fn body(response: axum::response::Response<Body>) -> Value {
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn named_validation_field_reaches_the_error_envelope() {
        let response = ApiError::from_kernel(
            KernelError::validation("workplace is required")
                .with_code("workplace_required")
                .with_field("workplace"),
        )
        .into_response();

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            body(response).await,
            serde_json::json!({
                "error": {
                    "code": "workplace_required",
                    "message": "workplace is required",
                    "errors": [{ "field": "workplace", "code": "workplace_required" }]
                }
            })
        );
    }

    #[tokio::test]
    async fn unavailable_has_one_public_code() {
        let response =
            ApiError::from_kernel(KernelError::unavailable("pool timed out")).into_response();

        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body(response).await["error"]["code"], "unavailable");
    }
}
