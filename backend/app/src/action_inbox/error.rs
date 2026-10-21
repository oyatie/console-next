use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use console_kernel_core::{ErrorKind, KernelError};

#[derive(Debug)]
pub(super) struct InboxError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl From<KernelError> for InboxError {
    fn from(error: KernelError) -> Self {
        let code = match error.kind {
            ErrorKind::Validation => "validation",
            ErrorKind::Internal => "internal",
            _ => "error",
        };
        let status = match error.kind {
            ErrorKind::Validation => StatusCode::UNPROCESSABLE_ENTITY,
            ErrorKind::Forbidden => StatusCode::FORBIDDEN,
            ErrorKind::NotFound => StatusCode::NOT_FOUND,
            ErrorKind::Conflict | ErrorKind::InvalidTransition => StatusCode::CONFLICT,
            ErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Self {
            status,
            code,
            message: error.message,
        }
    }
}

impl IntoResponse for InboxError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({
                "error": { "code": self.code, "message": self.message }
            })),
        )
            .into_response()
    }
}

#[cfg(test)]
#[cfg(not(feature = "test-postgres"))]
mod tests {
    use super::*;
    #[test]
    fn preserves_cursor_validation_and_source_failure_error_codes() {
        assert_eq!(
            InboxError::from(KernelError::validation("bad cursor")).code,
            "validation"
        );
        assert_eq!(
            InboxError::from(KernelError::internal("source failed")).code,
            "internal"
        );
    }
}
