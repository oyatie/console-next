//! The error envelope: `{"error": {"code", "message", "errors"?: [{field, code}]}}`.
//! A coded `KernelError` renders its own code (the frontend catalog renders by
//! code first); an uncoded one renders its kind. Internal details stay in the
//! log.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use console_kernel_core::{ErrorKind, KernelError};
use console_settings_adapter_postgres::PgSettingsError;
use serde_json::json;

#[derive(Debug)]
pub(crate) struct ApiError {
    status: StatusCode,
    error: KernelError,
}

impl From<KernelError> for ApiError {
    fn from(error: KernelError) -> Self {
        let status = match error.kind {
            ErrorKind::Validation => StatusCode::UNPROCESSABLE_ENTITY,
            ErrorKind::NotFound => StatusCode::NOT_FOUND,
            ErrorKind::Forbidden => StatusCode::FORBIDDEN,
            ErrorKind::Conflict | ErrorKind::InvalidTransition => StatusCode::CONFLICT,
            ErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Self { status, error }
    }
}

impl From<PgSettingsError> for ApiError {
    fn from(error: PgSettingsError) -> Self {
        match error {
            PgSettingsError::Domain(error) => error.into(),
            PgSettingsError::Db(error) => {
                tracing::error!(error = %error, "settings transaction failed");
                KernelError::internal("internal server error").into()
            }
        }
    }
}

const fn kind_code(kind: ErrorKind) -> &'static str {
    match kind {
        ErrorKind::Validation => "validation",
        ErrorKind::NotFound => "not_found",
        ErrorKind::Forbidden => "forbidden",
        ErrorKind::Conflict => "conflict",
        ErrorKind::InvalidTransition => "invalid_transition",
        ErrorKind::Internal => "internal",
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let code = self
            .error
            .code
            .unwrap_or_else(|| kind_code(self.error.kind));
        let message = if self.error.kind == ErrorKind::Internal {
            "internal server error".to_owned()
        } else {
            self.error.message
        };
        let mut body = json!({ "error": { "code": code, "message": message } });
        if let Some(field) = self.error.field {
            body["error"]["errors"] = json!([{ "field": field, "code": code }]);
        }
        (self.status, Json(body)).into_response()
    }
}
