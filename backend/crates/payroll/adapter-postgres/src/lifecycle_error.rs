// SPDX-License-Identifier: LicenseRef-Proprietary
use super::ClosePreflight;
use console_kernel_core::KernelError;
use console_platform_db::DbError;

#[derive(Debug, thiserror::Error)]
pub enum LifecycleError {
    /// Not found or other-org (RLS-indistinguishable).
    #[error("payroll run not found")]
    NotFound,
    #[error("attendance close preflight is blocked")]
    PreflightBlocked(ClosePreflight),
    #[error("{0}")]
    InvalidState(String),
    #[error("{0} exceptions are still open")]
    ExceptionsOpen(i64),
    #[error("the decider must not be the submitter (separation of duties)")]
    SodViolation,
    #[error("payroll decisions require bound natural persons")]
    IdentityUnbound,
    #[error("exception is already resolved")]
    AlreadyResolved,
    #[error("{0}")]
    InvalidTransition(String),
    #[error("payslip release gate is not satisfied: {0}")]
    LegalGate(String),
    #[error("{0}")]
    Validation(String),
    #[error(transparent)]
    Db(#[from] DbError),
}

impl From<sqlx::Error> for LifecycleError {
    fn from(value: sqlx::Error) -> Self {
        Self::Db(DbError::from(value))
    }
}

impl From<KernelError> for LifecycleError {
    fn from(value: KernelError) -> Self {
        Self::Validation(value.message)
    }
}

/// Map lifecycle failures onto [`KernelError`] kinds that match the REST
/// `from_lifecycle` status surface (404 / 422 / 409 / 500) and the CanonicalPort
/// PayRun path (`pay_run::lifecycle_into_kernel_error`). Store/REST callers that
/// convert via [`crate::PgPayrollError`] must not flatten Validation / Conflict /
/// InvalidTransition arms to `Internal` (5xx).
impl LifecycleError {
    #[must_use]
    pub fn into_kernel_error(self) -> KernelError {
        let message = self.to_string();
        match self {
            Self::IdentityUnbound => {
                KernelError::forbidden(message).with_code("payroll.refuse.identity_unbound")
            }
            Self::SodViolation => KernelError::conflict(message).with_code("sod_violation"),
            Self::NotFound => KernelError::not_found("run not found"),
            Self::Validation(_) => KernelError::validation(message),
            Self::InvalidTransition(_) => KernelError::invalid_transition(message),
            Self::InvalidState(_)
            | Self::PreflightBlocked(_)
            | Self::ExceptionsOpen(_)
            | Self::AlreadyResolved
            | Self::LegalGate(_) => KernelError::conflict(message),
            Self::Db(_) => KernelError::internal(message),
        }
    }
}

impl From<LifecycleError> for crate::PgPayrollError {
    fn from(value: LifecycleError) -> Self {
        match value {
            // Preserve Db so `PgPayrollError::kind` can still distinguish
            // sqlx RowNotFound from other DB failures.
            LifecycleError::Db(err) => Self::Db(err),
            other => Self::Domain(other.into_kernel_error()),
        }
    }
}
