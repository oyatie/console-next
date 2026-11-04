// SPDX-License-Identifier: LicenseRef-Proprietary
//! Payroll module admission uses the canonical loader and effective settings.
use console_kernel_core::{KernelError, OrgId};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

/// The phase is locked until the payroll transaction commits, including go-live races.
///
/// # Errors
/// Setup tenants and unavailable phase facts or Cedar decisions refuse creation.
pub async fn require_payroll_run_creation(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: Uuid,
) -> Result<(), KernelError> {
    use console_kernel_core::{TenantPhase, tenant_phase::PHASE_NOT_OPERATING};
    let phase: Option<String> =
        sqlx::query_scalar("SELECT phase FROM tenant_phase WHERE org_id=$1 FOR SHARE")
            .bind(org.as_uuid())
            .fetch_optional(tx.as_mut())
            .await
            .map_err(|_| KernelError::unavailable("tenant phase unavailable"))?;
    let allowed = super::super::actions::payroll_run_create::decide(
        &actor.to_string(),
        &org.to_string(),
        TenantPhase::from_db(phase.as_deref()) == TenantPhase::Operating,
    )
    .map_err(|_| KernelError::unavailable("payroll creation decision unavailable"))?;
    if !allowed {
        return Err(KernelError::conflict("available after go-live").with_code(PHASE_NOT_OPERATING));
    }
    Ok(())
}

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
