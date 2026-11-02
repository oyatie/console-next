// SPDX-License-Identifier: LicenseRef-Proprietary
//! Payroll module admission uses the canonical loader and effective settings.
use console_kernel_core::{KernelError, OrgId};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

/// The settings owner resolves the value without an authz → adapter dependency.
pub trait PayrollModuleFactLoader {
    fn payroll_enabled(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        org: OrgId,
    ) -> impl Future<Output = Result<bool, KernelError>> + Send;
}

/// # Errors
/// Disabled modules, unavailable settings or Cedar evaluation errors refuse access.
pub async fn require_payroll_module(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: Uuid,
    loader: &impl PayrollModuleFactLoader,
) -> Result<(), KernelError> {
    let enabled = loader.payroll_enabled(tx, org).await?;
    let allowed = super::super::actions::payroll_module::decide(
        &actor.to_string(),
        &org.to_string(),
        enabled,
    )
    .map_err(|_| KernelError::unavailable("payroll module decision unavailable"))?;
    if !allowed {
        return Err(
            KernelError::forbidden("payroll module is disabled").with_code("module_disabled")
        );
    }
    Ok(())
}
