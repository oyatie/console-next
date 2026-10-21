//! The attendance REST error body: `{"error": {"code", "message"}}`, with the
//! store and kernel errors mapped to their statuses (moved out of lib.rs).

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use console_attendance_adapter_postgres::AttendanceStoreError;
use console_kernel_core::{ErrorKind, KernelError};
use serde_json::json;

#[derive(Debug, Clone, Copy)]
pub(crate) struct RefusalCode(pub(crate) &'static str);

#[derive(Debug)]
pub(crate) struct RestError {
    pub(crate) status: StatusCode,
    pub(crate) code: &'static str,
    pub(crate) message: String,
    /// Rows a refusal carries (`error.details`), e.g. the cells of an `entry_conflict`.
    pub(crate) details: Option<serde_json::Value>,
}
impl RestError {
    pub(crate) fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            details: None,
        }
    }
    pub(crate) fn malformed_query() -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "invalid_query",
            "query parameters are invalid",
        )
    }
    pub(crate) fn kernel(error: KernelError) -> Self {
        match error.kind {
            ErrorKind::Validation => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation",
                error.message,
            ),
            ErrorKind::Forbidden => Self::new(StatusCode::FORBIDDEN, "forbidden", error.message),
            ErrorKind::NotFound => Self::new(StatusCode::NOT_FOUND, "not_found", error.message),
            ErrorKind::Conflict | ErrorKind::InvalidTransition => {
                Self::new(StatusCode::CONFLICT, "conflict", error.message)
            }
            ErrorKind::Internal => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "internal server error",
            ),
        }
    }
    pub(crate) fn store(error: AttendanceStoreError) -> Self {
        match error {
            AttendanceStoreError::Application(e) => match e {
                console_attendance_application::AttendanceApplicationError::ForbiddenBranch => {
                    Self::new(StatusCode::FORBIDDEN, "forbidden", e.to_string())
                }
                _ => Self::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "validation",
                    e.to_string(),
                ),
            },
            AttendanceStoreError::NotFound => {
                Self::new(StatusCode::NOT_FOUND, "not_found", "resource was not found")
            }
            AttendanceStoreError::Conflict => Self::new(
                StatusCode::CONFLICT,
                "conflict",
                "conflicting attendance state",
            ),
            AttendanceStoreError::CloseBlocked => Self::new(
                StatusCode::CONFLICT,
                "close_blocked",
                "open exceptions or a prior close block this close",
            ),
            AttendanceStoreError::InvalidCloseMonth => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation",
                "close month is outside the supported date range",
            ),
            AttendanceStoreError::Database(_) | AttendanceStoreError::Sql(_) => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "internal server error",
            ),
        }
    }
}
impl IntoResponse for RestError {
    fn into_response(self) -> Response {
        let mut error = json!({"code": self.code, "message": self.message});
        if let Some(details) = self.details {
            error["details"] = details;
        }
        let mut response = (self.status, Json(json!({ "error": error }))).into_response();
        response.extensions_mut().insert(RefusalCode(self.code));
        response
    }
}
