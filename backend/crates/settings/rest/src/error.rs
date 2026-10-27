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
    earliest: Option<console_kernel_core::Timestamp>,
    current_version: Option<Option<console_kernel_core::SettingVersionId>>,
}

impl From<KernelError> for ApiError {
    fn from(error: KernelError) -> Self {
        let status =
            StatusCode::from_u16(error.status_code()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        Self {
            status,
            error,
            earliest: None,
            current_version: None,
        }
    }
}

impl From<PgSettingsError> for ApiError {
    fn from(error: PgSettingsError) -> Self {
        match error {
            PgSettingsError::Domain(error) => error.into(),
            PgSettingsError::TooSoon { error, earliest } => Self {
                earliest: Some(earliest),
                ..error.into()
            },
            PgSettingsError::Stale {
                error,
                current_version,
            } => Self {
                current_version: Some(current_version),
                ..error.into()
            },
            PgSettingsError::Db(error) if error.is_unavailable() => {
                KernelError::unavailable("settings database unavailable").into()
            }
            PgSettingsError::Db(error) => {
                tracing::error!(error = %error, "settings transaction failed");
                KernelError::internal("internal server error").into()
            }
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let code = self.error.code.unwrap_or_else(|| self.error.kind.code());
        tracing::info!(code, "settings request refused");
        let message = if self.error.kind == ErrorKind::Internal {
            "internal server error".to_owned()
        } else {
            self.error.message
        };
        let mut body = json!({ "error": { "code": code, "message": message } });
        if let Some(version) = self.current_version {
            body["error"]["current_version"] = json!(version);
        }
        if let Some(earliest) = self.earliest {
            body["error"]["earliest_effective_from"] = json!(
                earliest
                    .format(&time::format_description::well_known::Rfc3339)
                    .unwrap_or_default()
            );
        }
        if let Some(field) = self.error.field {
            body["error"]["errors"] = json!([{ "field": field, "code": code }]);
        }
        (self.status, Json(body)).into_response()
    }
}
