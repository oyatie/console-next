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
    hold_until: Option<time::OffsetDateTime>,
    support_ref: bool,
}

impl PlatformError {
    pub(crate) fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            field: None,
            hold_until: None,
            support_ref: false,
        }
    }

    pub(crate) fn with_support_ref(mut self) -> Self {
        self.support_ref = true;
        self
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
            ProvisioningError::OpsRecoveryHoldActive(until) => {
                let mut error = Self::new(
                    StatusCode::CONFLICT,
                    "ops_recovery_hold_active",
                    "ops_recovery_hold_active",
                );
                error.hold_until = until;
                error
            }
            ProvisioningError::OpsRecovery(code) => Self::new(
                if matches!(
                    code,
                    "forbidden"
                        | "ops_recovery_sod_requester"
                        | "ops_recovery_shared_authenticator"
                ) {
                    StatusCode::FORBIDDEN
                } else if code == "unauthorized" {
                    StatusCode::UNAUTHORIZED
                } else if code == "ops_recovery_evidence_identifier" {
                    StatusCode::UNPROCESSABLE_ENTITY
                } else {
                    StatusCode::CONFLICT
                },
                code,
                code,
            ),
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
        let support_ref =
            (self.support_ref || self.code.starts_with("ops_recovery_")).then(uuid::Uuid::new_v4);
        if let Some(reference) = support_ref {
            tracing::warn!(support_ref=%reference, error_code=self.code, "platform recovery refused");
        }
        (
            self.status,
            Json(ErrorBody {
                error: ErrorPayload {
                    code: self.code,
                    hold_until: self.hold_until,
                    support_ref,
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
    #[serde(
        skip_serializing_if = "Option::is_none",
        with = "time::serde::rfc3339::option"
    )]
    hold_until: Option<time::OffsetDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    support_ref: Option<uuid::Uuid>,
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

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn support_reference_is_limited_to_recovery_refusals() {
        use axum::body::to_bytes;
        for code in [
            "ops_recovery_cancelled",
            "unauthorized",
            "passkey_required",
            "forbidden",
            "not_found",
            "validation",
            "internal",
            "overloaded",
        ] {
            for recovery in [false, true] {
                let mut error = PlatformError::new(StatusCode::CONFLICT, code, code);
                if recovery {
                    error = error.with_support_ref();
                }
                let bytes = to_bytes(error.into_response().into_body(), usize::MAX)
                    .await
                    .unwrap();
                let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(
                    body["error"]["support_ref"].is_string(),
                    recovery || code.starts_with("ops_recovery_"),
                    "{code}, recovery={recovery}"
                );
            }
        }
    }
}
