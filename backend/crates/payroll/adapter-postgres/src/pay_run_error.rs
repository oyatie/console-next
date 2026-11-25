// SPDX-License-Identifier: LicenseRef-Proprietary
//! The PayRun port's failures and the kernel errors they answer with.
use console_kernel_core::KernelError;
use console_ontology_canonical_domain::CanonicalPortError;
use uuid::Uuid;

use super::StageDraftError;

#[derive(Debug, thiserror::Error)]
pub enum PayRunError {
    #[error("preflight blocked the command: {0:?}")]
    Blocked(Vec<String>),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Lifecycle(#[from] crate::lifecycle::LifecycleError),
    #[error("command {0} was already applied with a different payload")]
    DigestConflict(Uuid),
    #[error("a payroll draft for this run and period already exists with different provenance")]
    ProvenanceConflict,
    #[error("payroll period is locked; draft not staged")]
    PeriodLocked,
    #[error("stored receipt for command {0} names no dispatch target: {1}")]
    UnreadableReceipt(Uuid, String),
    /// The caller's access to the run could not be decided.
    #[error(transparent)]
    Access(#[from] KernelError),
}

impl CanonicalPortError for PayRunError {
    fn into_kernel_error(self) -> KernelError {
        match self {
            Self::Blocked(_) => KernelError::validation(self.to_string()),
            Self::DigestConflict(_) | Self::ProvenanceConflict | Self::PeriodLocked => {
                KernelError::conflict(self.to_string())
            }
            Self::Lifecycle(err) => lifecycle_into_kernel_error(err),
            Self::Access(err) => err,
            Self::Database(_) | Self::UnreadableReceipt(_, _) => {
                KernelError::internal(self.to_string())
            }
        }
    }
}

/// Map payroll lifecycle failures onto [`KernelError`] kinds that match the
/// REST `from_lifecycle` status surface (404 / 422 / 409 / 500), instead of
/// flattening every arm to `Internal` via [`PayRunError::Lifecycle`].
fn lifecycle_into_kernel_error(err: crate::lifecycle::LifecycleError) -> KernelError {
    match err {
        crate::lifecycle::LifecycleError::NotFound => KernelError::not_found(err.to_string()),
        other => other.into_kernel_error(),
    }
}

/// Map the staging writer's failure arms onto the port's error surface: a
/// driver failure is [`PayRunError::Database`], a changed provenance is
/// [`PayRunError::ProvenanceConflict`], a locked period is
/// [`PayRunError::PeriodLocked`] (unreachable from the ungated canonical path).
impl From<StageDraftError> for PayRunError {
    fn from(err: StageDraftError) -> Self {
        match err {
            StageDraftError::Db(db) => Self::Database(db),
            StageDraftError::ProvenanceMismatch => Self::ProvenanceConflict,
            StageDraftError::PeriodLocked => Self::PeriodLocked,
        }
    }
}
