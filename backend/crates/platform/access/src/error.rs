//! Why an access use case refused. The REST face maps [`Refusal`] to HTTP.

use console_kernel_core::{ErrorKind, KernelError};
use console_platform_db::DbError;

/// The class of a refusal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    Invalid,
    NotFound,
    Forbidden,
    Conflict,
    StepUpRequired,
    StepUpFailed,
    Unavailable,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessError {
    pub kind: Refusal,
    pub code: &'static str,
    pub message: String,
    /// The record's current version, on `stale_revision`.
    pub current_version: Option<i32>,
    pub original_operation_id: Option<uuid::Uuid>,
    /// The input a validation refusal points at.
    pub field: Option<String>,
}

pub type AccessResult<T> = Result<T, AccessError>;

impl AccessError {
    pub(crate) fn new(kind: Refusal, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            code,
            message: message.into(),
            current_version: None,
            original_operation_id: None,
            field: None,
        }
    }

    pub(crate) fn forbidden(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(Refusal::Forbidden, code, message)
    }

    pub(crate) fn not_found(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(Refusal::NotFound, code, message)
    }

    pub(crate) fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(Refusal::Conflict, code, message)
    }

    pub(crate) fn invalid(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(Refusal::Invalid, code, message)
    }

    pub(crate) fn stale(current_version: i32) -> Self {
        Self {
            current_version: Some(current_version),
            ..Self::conflict("stale_revision", "the role changed since it was read")
        }
    }

    pub(crate) fn access_denied() -> Self {
        Self::forbidden(
            "access_denied",
            "권한 관리 권한이 없습니다 (access management is not granted)",
        )
    }

    /// A per-item refusal (anything but a store failure).
    pub(crate) const fn is_refusal(&self) -> bool {
        !matches!(self.kind, Refusal::Internal | Refusal::Unavailable)
    }

    pub(crate) fn internal(detail: impl std::fmt::Display) -> Self {
        // Never leak SQL or schema detail; log it.
        tracing::error!(error = %detail, "access store error");
        Self::new(Refusal::Internal, "internal", "internal server error")
    }

    fn unavailable() -> Self {
        Self::new(
            Refusal::Unavailable,
            "unavailable",
            "access database unavailable",
        )
    }
}

impl From<DbError> for AccessError {
    fn from(err: DbError) -> Self {
        if err.is_unavailable() {
            Self::unavailable()
        } else {
            Self::internal(err)
        }
    }
}

impl From<sqlx::Error> for AccessError {
    fn from(err: sqlx::Error) -> Self {
        Self::from(DbError::from(err))
    }
}

impl From<KernelError> for AccessError {
    fn from(err: KernelError) -> Self {
        let kind = match err.kind {
            ErrorKind::Validation => Refusal::Invalid,
            ErrorKind::NotFound => Refusal::NotFound,
            ErrorKind::Forbidden => Refusal::Forbidden,
            ErrorKind::Conflict | ErrorKind::InvalidTransition => Refusal::Conflict,
            ErrorKind::Unavailable => Refusal::Unavailable,
            ErrorKind::Internal => return Self::internal(err.message),
        };
        Self {
            field: err.field,
            ..Self::new(kind, err.code.unwrap_or(err.kind.code()), err.message)
        }
    }
}
