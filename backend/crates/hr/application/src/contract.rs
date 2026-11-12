// SPDX-License-Identifier: LicenseRef-Proprietary
//! Internal terms read port; callers authorize their HR/payroll action before opening the transaction.
use console_hr_domain::contract::{ContractRow, terms_on};
use console_kernel_core::KernelError;
use std::future::Future;
use time::Date;
use uuid::Uuid;

pub trait ContractRowsPort<Tx: Send>: Sync {
    type Error: From<KernelError>;
    fn load_rows(
        &self,
        tx: &mut Tx,
        org: Uuid,
        employee: Uuid,
    ) -> impl Future<Output = Result<Vec<ContractRow>, Self::Error>> + Send;
}

/// # Errors
/// Propagates storage failures and domain refusals for ambiguous or invalid terms.
pub async fn employee_terms_on<Tx: Send, P: ContractRowsPort<Tx>>(
    port: &P,
    tx: &mut Tx,
    org: Uuid,
    employee: Uuid,
    day: Date,
) -> Result<Option<ContractRow>, P::Error> {
    let rows = port.load_rows(tx, org, employee).await?;
    Ok(terms_on(&rows, day)?.cloned())
}
