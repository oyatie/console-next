// SPDX-License-Identifier: LicenseRef-Proprietary
use console_kernel_core::{ErrorKind, KernelError};
use console_platform_db::DbError;

use crate::pay_run;

#[derive(Debug, thiserror::Error)]
pub enum PgPayrollError {
    #[error(transparent)]
    Db(#[from] DbError),

    #[error(transparent)]
    Domain(#[from] KernelError),
}

impl PgPayrollError {
    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::Domain(err) => err.kind,
            Self::Db(error) => error.kind(),
        }
    }
}

impl From<sqlx::Error> for PgPayrollError {
    fn from(value: sqlx::Error) -> Self {
        Self::Db(DbError::from(value))
    }
}

impl From<pay_run::StageDraftError> for PgPayrollError {
    fn from(err: pay_run::StageDraftError) -> Self {
        match err {
            pay_run::StageDraftError::Db(db) => Self::Db(DbError::Sqlx(db)),
            pay_run::StageDraftError::ProvenanceMismatch => Self::Domain(KernelError::conflict(
                "a payroll draft for this run and period already exists with different provenance",
            )),
            pay_run::StageDraftError::PeriodLocked => Self::Domain(KernelError::conflict(
                "payroll period is locked; draft not staged",
            )),
        }
    }
}

impl From<PgPayrollError> for KernelError {
    fn from(value: PgPayrollError) -> Self {
        match value {
            PgPayrollError::Domain(err) => err,
            PgPayrollError::Db(err) => KernelError::internal(err.to_string()),
        }
    }
}
