// SPDX-License-Identifier: LicenseRef-Proprietary
//! How a lifecycle or inbox failure answers over HTTP: each refusal keeps its
//! own status and code, and a database failure is logged, never shown.

use axum::http::StatusCode;
use console_inbox_adapter_postgres::PgInboxError;
use console_payroll_adapter_postgres::lifecycle;
use serde_json::json;

use crate::RestError;

impl RestError {
    pub(super) fn from_lifecycle(err: lifecycle::LifecycleError) -> Self {
        use lifecycle::LifecycleError as E;
        match err {
            E::NotFound => Self::new(StatusCode::NOT_FOUND, "not_found", "run not found"),
            E::PreflightBlocked(preflight) => {
                let details = serde_json::to_value(&preflight).ok();
                Self::new(
                    StatusCode::CONFLICT,
                    "preflight_blocked",
                    "attendance close preflight is blocked",
                )
                .with_details(details)
            }
            E::InvalidState(message) => Self::new(StatusCode::CONFLICT, "invalid_state", message),
            E::ExceptionsOpen(open) => Self::new(
                StatusCode::CONFLICT,
                "exceptions_open",
                format!("{open} exceptions are still open"),
            )
            .with_details(Some(json!({ "open": open }))),
            E::IdentityUnbound | E::SodViolation | E::NothingCalculated => {
                Self::from_kernel(err.into_kernel_error())
            }
            E::AlreadyResolved => Self::new(
                StatusCode::CONFLICT,
                "already_resolved",
                "exception is already resolved",
            ),
            E::InvalidTransition(message) => {
                Self::new(StatusCode::CONFLICT, "invalid_transition", message)
            }
            E::LegalGate(message) => Self::new(StatusCode::CONFLICT, "legal_gate", message),
            E::Validation(message) => {
                Self::new(StatusCode::UNPROCESSABLE_ENTITY, "validation", message)
            }
            E::Db(err) => {
                tracing::error!(error = %err, "payroll lifecycle db error");
                Self::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal",
                    "internal server error",
                )
            }
        }
    }

    pub(super) fn from_inbox(err: PgInboxError) -> Self {
        match err {
            PgInboxError::Domain(err) => Self::from_kernel(err),
            other => {
                tracing::error!(error = %other, "payslip inbox delivery error");
                Self::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal",
                    "internal server error",
                )
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_with_nothing_calculated_is_refused_with_its_own_code() {
        let refusal = RestError::from_lifecycle(lifecycle::LifecycleError::NothingCalculated);
        assert_eq!(
            (refusal.status, refusal.code),
            (StatusCode::CONFLICT, "nothing_calculated")
        );
    }
}
