use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use console_platform_provisioning::ProvisioningError;
use serde::Serialize;

#[derive(Debug)]
pub(crate) struct PlatformError {
    status: StatusCode,
    code: &'static str,
    message: String,
    field: Option<&'static str>,
}

impl PlatformError {
    pub(crate) fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            field: None,
        }
    }

    /// The request field the refusal is about (`error.errors[0].field`).
    fn on(mut self, field: &'static str) -> Self {
        self.field = Some(field);
        self
    }

    pub(crate) fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", message)
    }

    pub(crate) fn validation(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNPROCESSABLE_ENTITY, "validation", message)
    }

    pub(crate) fn from_provisioning(err: ProvisioningError) -> Self {
        match err {
            // Caller-facing input problems map to 422; everything else is logged
            // and collapsed to a generic 500 so no DB/constraint detail leaks.
            ProvisioningError::InvalidRoster(message) => Self::validation(message),
            ProvisioningError::ActiveBootstrapCredentialExists => Self::new(
                StatusCode::CONFLICT,
                "conflict",
                "tenant admin already has an active bootstrap credential",
            ),
            ProvisioningError::NotFound(message) => {
                Self::new(StatusCode::NOT_FOUND, "not_found", message)
            }
            ProvisioningError::Conflict(message) => {
                Self::new(StatusCode::CONFLICT, "conflict", message)
            }
            ProvisioningError::DomainRequestForbidden => {
                Self::forbidden("only the tenant ops account may request a company-domain change")
            }
            ProvisioningError::SlugTaken => Self::new(
                StatusCode::CONFLICT,
                "slug_taken",
                "another tenant already uses this slug",
            )
            .on("slug"),
            ProvisioningError::SlugInvalid(message) => {
                Self::new(StatusCode::UNPROCESSABLE_ENTITY, "slug_invalid", message).on("slug")
            }
            ProvisioningError::UserAlreadyHasPasskey => Self::new(
                StatusCode::CONFLICT,
                "admin_already_enrolled",
                "tenant admin has already enrolled a passkey",
            ),
            other => {
                tracing::error!(error = %other, "platform provisioning error");
                Self::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal",
                    "internal server error",
                )
            }
        }
    }
}

impl IntoResponse for PlatformError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorBody {
                error: ErrorPayload {
                    code: self.code,
                    message: self.message,
                    errors: self.field.map(|field| {
                        vec![FieldError {
                            field,
                            code: self.code,
                        }]
                    }),
                },
            }),
        )
            .into_response()
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct ErrorBody {
    error: ErrorPayload,
}

#[derive(Debug, Serialize)]
pub(crate) struct ErrorPayload {
    code: &'static str,
    message: String,
    /// `ErrorBody.errors[]`: the request field a refusal is about.
    #[serde(skip_serializing_if = "Option::is_none")]
    errors: Option<Vec<FieldError>>,
}

#[derive(Debug, Serialize)]
pub(crate) struct FieldError {
    field: &'static str,
    code: &'static str,
}
