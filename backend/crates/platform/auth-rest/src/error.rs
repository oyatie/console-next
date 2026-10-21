use axum::Json;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::response::Response;
use console_kernel_core::ErrorKind;
use console_kernel_core::KernelError;
use console_platform_auth::RefreshTokenUseError;
use console_platform_db::DbError;
use console_platform_provisioning::ProvisioningError;
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

#[derive(Debug)]
pub(crate) struct RestError {
    pub(crate) status: StatusCode,
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl RestError {
    pub(crate) fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "bad_request",
            message: message.into(),
        }
    }

    pub(crate) fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "unauthorized",
            message: message.into(),
        }
    }

    pub(crate) fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code: "conflict",
            message: message.into(),
        }
    }

    pub(crate) fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: "not_found",
            message: message.into(),
        }
    }

    pub(crate) fn unavailable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "service_unavailable",
            message: message.into(),
        }
    }

    pub(crate) fn validation(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: "validation",
            message: message.into(),
        }
    }

    pub(crate) fn bad_gateway(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: "bad_gateway",
            message: message.into(),
        }
    }

    pub(crate) fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code: "forbidden",
            message: message.into(),
        }
    }

    /// 403 `passkey_required`: the caller's user has no enrolled passkey (an
    /// OTP-only first-login session, `requires_passkey_setup == true`).
    pub(crate) fn passkey_required() -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code: "passkey_required",
            message: "enroll a passkey before performing this action".to_owned(),
        }
    }

    /// 403 `tenant_inactive`: the account's tenant is SUSPENDED or ARCHIVED, so
    /// no session is issued (checked after the credential is proven).
    pub(crate) fn tenant_inactive() -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code: "tenant_inactive",
            message: "this company's service is suspended; contact the service operator".to_owned(),
        }
    }

    /// 422 `sign_in_id_invalid`: not `<아이디>@<domain>` by the sign-in ID rule.
    /// Syntax only: it says nothing about whether such an account exists.
    pub(crate) fn sign_in_id_invalid() -> Self {
        Self {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: "sign_in_id_invalid",
            message: "the sign-in ID must be <id>@<company domain> with a-z, 0-9, '.', '_' or '-'"
                .to_owned(),
        }
    }

    pub(crate) fn too_many_requests() -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            code: "too_many_requests",
            message: "too many requests; please retry later".to_owned(),
        }
    }

    pub(crate) fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal",
            message: message.into(),
        }
    }

    pub(crate) fn from_kernel(error: KernelError) -> Self {
        match error.kind {
            ErrorKind::Validation => RestError::bad_request(error.message),
            ErrorKind::NotFound => RestError::not_found(error.message),
            ErrorKind::Forbidden => RestError::forbidden(error.message),
            ErrorKind::Conflict | ErrorKind::InvalidTransition => {
                RestError::conflict(error.message)
            }
            ErrorKind::Unavailable => RestError::unavailable(error.message),
            ErrorKind::Internal => RestError::internal(error.message),
        }
    }

    pub(crate) fn from_refresh(error: RefreshTokenUseError) -> Self {
        match error {
            RefreshTokenUseError::InvalidToken => Self::unauthorized(error.to_string()),
            RefreshTokenUseError::Expired => Self {
                status: StatusCode::UNAUTHORIZED,
                code: "session_expired",
                message: error.to_string(),
            },
            RefreshTokenUseError::FamilyRevoked | RefreshTokenUseError::ReuseDetected => Self {
                status: StatusCode::UNAUTHORIZED,
                code: "session_revoked",
                message: error.to_string(),
            },
            RefreshTokenUseError::PasskeyReset => Self {
                status: StatusCode::UNAUTHORIZED,
                code: "session_passkey_reset",
                message: error.to_string(),
            },
            RefreshTokenUseError::AccountDeactivated => Self {
                status: StatusCode::UNAUTHORIZED,
                code: "session_deactivated",
                message: error.to_string(),
            },
            RefreshTokenUseError::SignedOutElsewhere => Self {
                status: StatusCode::UNAUTHORIZED,
                code: "session_signed_out_elsewhere",
                message: error.to_string(),
            },
            // INF-03: the client says why the session ended (signed out for inactivity).
            RefreshTokenUseError::IdleExpired => Self {
                status: StatusCode::UNAUTHORIZED,
                code: "session_idle_expired",
                message: error.to_string(),
            },
            RefreshTokenUseError::Storage => Self::internal(error.to_string()),
        }
    }

    pub(crate) fn from_provisioning(error: ProvisioningError) -> Self {
        match error {
            // Generic, non-revealing message for any OTP-redeem rejection so the
            // client cannot distinguish unknown vs expired vs already-used.
            ProvisioningError::InvalidBootstrapCredential => {
                Self::unauthorized("invalid or expired one-time code")
            }
            ProvisioningError::UserAlreadyHasPasskey
            | ProvisioningError::ActiveBootstrapCredentialExists => {
                Self::conflict(error.to_string())
            }
            ProvisioningError::NotFound(_) => Self::not_found(error.to_string()),
            ProvisioningError::Conflict(_) | ProvisioningError::SlugTaken => {
                Self::conflict(error.to_string())
            }
            ProvisioningError::OpsRecovery(_)
            | ProvisioningError::OpsRecoveryHoldActive(_)
            | ProvisioningError::Sqlx(_)
            | ProvisioningError::Db(_)
            | ProvisioningError::Json(_)
            | ProvisioningError::Auth(_)
            | ProvisioningError::Kernel(_)
            | ProvisioningError::InvalidRoster(_)
            | ProvisioningError::SlugInvalid(_)
            | ProvisioningError::DomainRequestForbidden
            | ProvisioningError::UnknownBranch { .. } => Self::internal(error.to_string()),
        }
    }
}

impl From<DbError> for RestError {
    fn from(value: DbError) -> Self {
        Self::internal(value.to_string())
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

#[cfg(test)]
mod recovery_reason_tests {
    use super::*;

    #[test]
    fn refresh_refusals_expose_only_the_recovery_code() {
        for (reason, code) in [
            (RefreshTokenUseError::Expired, "session_expired"),
            (RefreshTokenUseError::IdleExpired, "session_idle_expired"),
            (RefreshTokenUseError::FamilyRevoked, "session_revoked"),
            (RefreshTokenUseError::PasskeyReset, "session_passkey_reset"),
            (
                RefreshTokenUseError::AccountDeactivated,
                "session_deactivated",
            ),
            (
                RefreshTokenUseError::SignedOutElsewhere,
                "session_signed_out_elsewhere",
            ),
        ] {
            let error = RestError::from_refresh(reason);
            assert_eq!(error.status, StatusCode::UNAUTHORIZED);
            assert_eq!(error.code, code);
        }
    }
}
