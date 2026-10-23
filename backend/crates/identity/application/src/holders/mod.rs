// SPDX-License-Identifier: LicenseRef-Proprietary
//! Identity owns every current-holder question; adapters evaluate live grants.
use console_kernel_core::KernelError;
use std::{collections::BTreeSet, future::Future};
use uuid::Uuid;

pub trait HolderResolver {
    /// Distinct active accounts whose current grants cover the requested act.
    fn resolve(&mut self) -> impl Future<Output = Result<BTreeSet<Uuid>, KernelError>> + Send;
}
