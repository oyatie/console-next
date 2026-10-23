use crate::workbench::SourceFailure as WorkbenchSourceFailure;
use axum::response::{IntoResponse, Response};
use console_kernel_core::{ErrorKind, KernelError};

use crate::http::error::{FieldError, MappedKernelError, error_response};

#[derive(Debug)]
pub(super) struct InboxError {
    status: axum::http::StatusCode,
    code: &'static str,
    message: String,
    errors: Option<Vec<FieldError>>,
}

impl From<KernelError> for InboxError {
    fn from(error: KernelError) -> Self {
        let mapped = MappedKernelError::from(error);
        Self {
            status: mapped.status,
            code: mapped.code,
            message: mapped.message,
            errors: mapped.errors,
        }
    }
}

impl IntoResponse for InboxError {
    fn into_response(self) -> Response {
        error_response(self.status, self.code, self.message, self.errors)
    }
}

pub(super) fn workbench_source_error(error: KernelError) -> WorkbenchSourceFailure {
    if error.kind == ErrorKind::Forbidden {
        WorkbenchSourceFailure::Denied {
            code: "action_inbox_access_denied",
        }
    } else {
        WorkbenchSourceFailure::Unavailable {
            code: "action_inbox_unavailable",
        }
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
