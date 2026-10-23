use axum::Json;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::response::Response;
use console_identity_adapter_postgres::PgOrgError;
use console_kernel_core::ErrorKind;
use console_kernel_core::KernelError;
use console_platform_db::DbError;
use console_platform_request_context::RequestContextError;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub(crate) struct ErrorBody {
    pub(crate) error: ErrorPayload,
}

#[derive(Debug, Serialize)]
pub(crate) struct ErrorPayload {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/// Public (doc-hidden) only because [`authorize_org_manage_observed`] is exposed for
/// the moved integration tests and names this in its return type; it stays an opaque
/// error (all fields private) and is not part of the crate's supported API.
#[doc(hidden)]
#[derive(Debug)]
pub struct RestError {
    pub(crate) status: StatusCode,
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl RestError {
    pub(crate) fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    pub(crate) fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_request", message)
    }

    pub(crate) fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", message)
    }

    pub(crate) fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", message)
    }

    pub(crate) fn validation(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNPROCESSABLE_ENTITY, "validation", message)
    }

    pub(crate) fn unavailable(message: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "unavailable", message)
    }

    pub(crate) fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", message)
    }

    pub(crate) fn from_kernel(error: KernelError) -> Self {
        let mut rest = match error.kind {
            ErrorKind::Validation => Self::validation(error.message),
            ErrorKind::Forbidden => Self::forbidden(error.message),
            ErrorKind::NotFound => Self::new(StatusCode::NOT_FOUND, "not_found", error.message),
            ErrorKind::Conflict | ErrorKind::InvalidTransition => {
                Self::new(StatusCode::CONFLICT, "conflict", error.message)
            }
            ErrorKind::Unavailable => return Self::unavailable(error.message),
            ErrorKind::Internal => return Self::internal(error.message),
        };
        // A typed refusal (`sign_in_id_taken`, a reason code's) keeps its code.
        if let Some(code) = error.code {
            rest.code = code;
        }
        rest
    }

    pub(crate) fn from_store(error: PgOrgError) -> Self {
        match error {
            // Domain errors carry safe, caller-facing messages.
            PgOrgError::Domain(kernel) => Self::from_kernel(kernel),
            // Db errors must never leak raw sqlx strings / constraint names
            // (schema disclosure, OWASP A05). Log server-side; return generic.
            db_error => {
                let kind = db_error.kind();
                tracing::error!(error = %db_error, "identity database error");
                match kind {
                    ErrorKind::NotFound => {
                        Self::new(StatusCode::NOT_FOUND, "not_found", "resource not found")
                    }
                    ErrorKind::Conflict | ErrorKind::InvalidTransition => {
                        Self::new(StatusCode::CONFLICT, "conflict", "resource already exists")
                    }
                    ErrorKind::Validation => {
                        Self::validation("request references an unknown region or branch")
                    }
                    _ => Self::internal("internal server error"),
                }
            }
        }
    }
}

/// A bare `DbError` surfaced from a `with_org_conn`/`with_audits` closure (the
/// passkey self-management reads/writes) is an internal failure: it must never
/// leak a raw sqlx string / constraint name to the caller (schema disclosure,
/// OWASP A05). Log server-side and return a generic 500.
impl From<DbError> for RestError {
    fn from(error: DbError) -> Self {
        tracing::error!(error = %error, "identity passkey database error");
        Self::internal("internal server error")
    }
}

/// A missing/invalid request context at a tenant-scoped data-access site is an
/// internal invariant violation (the request reached a tenant read without an
/// armed org). It never produces tenant data, so it maps to a generic 500.
impl From<RequestContextError> for RestError {
    fn from(error: RequestContextError) -> Self {
        tracing::error!(error = %error, "identity request context error");
        Self::internal("internal server error")
    }
}

impl IntoResponse for RestError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorBody {
                error: ErrorPayload {
                    code: self.code,
                    message: self.message,
                },
            }),
        )
            .into_response()
    }
}
