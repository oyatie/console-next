// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{LedgerRequest, RestError};
use console_compliance_application::{ArrivalEventQuery, LocationConsentLedgerQuery};
use console_kernel_core::KernelError;

pub(super) fn normalize_ledger_query(
    query: LedgerRequest,
) -> Result<LocationConsentLedgerQuery, RestError> {
    let limit = query.limit.unwrap_or(100).clamp(1, 1_000);
    let offset = query.offset.unwrap_or(0);
    if offset < 0 {
        return Err(RestError::from_kernel(KernelError::validation(
            "offset must be non-negative",
        )));
    }

    Ok(LocationConsentLedgerQuery {
        user_id: query.user_id,
        branch_id: query.branch_id,
        limit,
        offset,
    })
}

pub(super) fn normalize_arrival_query(
    query: LedgerRequest,
) -> Result<ArrivalEventQuery, RestError> {
    let limit = query.limit.unwrap_or(100).clamp(1, 1_000);
    let offset = query.offset.unwrap_or(0);
    if offset < 0 {
        return Err(RestError::from_kernel(KernelError::validation(
            "offset must be non-negative",
        )));
    }
    Ok(ArrivalEventQuery {
        user_id: query.user_id,
        branch_id: query.branch_id,
        limit,
        offset,
    })
}
