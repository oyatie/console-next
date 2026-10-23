//! One error mapping for the face: `{"error": {code, message, errors[], reasons[]}}`.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use console_entity_adapter_postgres::PgEntityError;
use console_entity_domain::Refusal;
use console_kernel_core::{ErrorKind, KernelError};
use console_platform_request_context::RequestContextError;
use serde_json::json;

#[derive(Debug)]
pub(crate) struct RestError(pub Refusal);

impl From<Refusal> for RestError {
    fn from(value: Refusal) -> Self {
        Self(value)
    }
}

impl From<KernelError> for RestError {
    fn from(value: KernelError) -> Self {
        Self(Refusal::from(value))
    }
}

impl From<PgEntityError> for RestError {
    fn from(value: PgEntityError) -> Self {
        match value {
            PgEntityError::Refused(r) => Self(r),
            PgEntityError::Db(err) => {
                // Never leak sqlx/schema internals; log server-side.
                tracing::error!(error = %err, "entity store error");
                Self(Refusal::new(
                    ErrorKind::Internal,
                    "internal",
                    "internal server error",
                ))
            }
        }
    }
}

impl From<RequestContextError> for RestError {
    fn from(err: RequestContextError) -> Self {
        let (kind, code) = match err {
            RequestContextError::VerifierUnavailable => (ErrorKind::Internal, "unavailable"),
            RequestContextError::WrongTokenTier => (ErrorKind::Forbidden, "forbidden"),
            RequestContextError::AccessScope(_) => (ErrorKind::Forbidden, "forbidden"),
            RequestContextError::MissingBearer
            | RequestContextError::InvalidToken
            | RequestContextError::InvalidClaim(_) => {
                return Self(Refusal::new(
                    ErrorKind::Forbidden,
                    "unauthorized",
                    "missing or invalid bearer token",
                ));
            }
            _ => (ErrorKind::Internal, "internal"),
        };
        Self(Refusal::new(kind, code, code))
    }
}

impl IntoResponse for RestError {
    fn into_response(self) -> Response {
        let r = self.0;
        let status = match (r.kind, r.code) {
            (_, "unauthorized") => StatusCode::UNAUTHORIZED,
            (_, "passkey_step_up_required") => StatusCode::PRECONDITION_REQUIRED,
            (_, "rate_limited") => StatusCode::TOO_MANY_REQUESTS,
            (ErrorKind::Validation, _) => StatusCode::UNPROCESSABLE_ENTITY,
            (ErrorKind::NotFound, _) => StatusCode::NOT_FOUND,
            (ErrorKind::Forbidden, _) => StatusCode::FORBIDDEN,
            (ErrorKind::Conflict | ErrorKind::InvalidTransition, _) => StatusCode::CONFLICT,
            (ErrorKind::Unavailable, _) => StatusCode::SERVICE_UNAVAILABLE,
            (ErrorKind::Internal, "unavailable") => StatusCode::SERVICE_UNAVAILABLE,
            (ErrorKind::Internal, _) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        let mut error = json!({ "code": r.code, "message": r.message });
        if !r.fields.is_empty() {
            error["errors"] = json!(r.fields);
        }
        if let Some(version) = r.current_version {
            error["current_version"] = json!(version);
        }
        if let Some(remedy) = r.remedy {
            error["reasons"] = json!([remedy]);
        }
        (status, Json(json!({ "error": error }))).into_response()
    }
}
