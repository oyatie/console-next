// SPDX-License-Identifier: LicenseRef-Proprietary
use console_kernel_core::{ErrorKind, KernelError};

use crate::PgLeaveError;

pub(super) fn error_kind(err: &PgLeaveError) -> ErrorKind {
    match err {
        PgLeaveError::Domain(err) => err.kind,
        PgLeaveError::MissingHomeBranch
        | PgLeaveError::OverlappingRequest
        | PgLeaveError::PeriodClosed
        | PgLeaveError::ChargeReviewRequired(_)
        | PgLeaveError::ConcurrentModification => ErrorKind::Conflict,
        PgLeaveError::CommandUnavailable => ErrorKind::Internal,
        PgLeaveError::Db(error) => error.kind(),
    }
}

pub(super) fn into_kernel(value: PgLeaveError) -> KernelError {
    match value {
        PgLeaveError::Domain(err) => err,
        PgLeaveError::Db(err) => KernelError::internal(format!("{err:?}")),
        PgLeaveError::MissingHomeBranch => {
            KernelError::conflict("active employee has no explicit home branch")
        }
        PgLeaveError::OverlappingRequest => KernelError::conflict(
            "leave request overlaps an existing pending or approved leave request",
        ),
        PgLeaveError::PeriodClosed => {
            KernelError::conflict("leave request covers a closed attendance or payroll period")
        }
        PgLeaveError::ChargeReviewRequired(_) => {
            KernelError::conflict("leave charge requires review before approval")
        }
        PgLeaveError::ConcurrentModification => {
            KernelError::conflict("leave request version changed concurrently")
        }
        PgLeaveError::CommandUnavailable => {
            KernelError::internal("leave command database capability is unavailable")
        }
    }
}
