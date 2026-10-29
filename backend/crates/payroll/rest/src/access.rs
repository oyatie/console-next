// SPDX-License-Identifier: LicenseRef-Proprietary
//! Payroll decisions share the canonical fact loader and the data transaction.
use console_kernel_core::{OrgId, UserId};
use console_platform_authz::Feature;
use console_platform_authz::access::{NodeKind, NodeRef};
use console_platform_authz::cedar_pbac::visible::load_facts;
use sqlx::{Postgres, Transaction};

use crate::RestError;

pub(crate) async fn require_run_read_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
) -> Result<(), RestError> {
    let facts = load_facts(tx, org, *actor.as_uuid())
        .await
        .map_err(RestError::from_kernel)?;
    // Runs have no legal-entity scope yet; narrower grants cannot disclose tenant totals.
    let allowed = facts
        .authorize(
            Feature::PayrollRunRead.as_str(),
            NodeRef {
                kind: NodeKind::Tenant,
                id: *org.as_uuid(),
            },
        )
        .map_err(|error| {
            tracing::error!(%error, "payroll Cedar read failed");
            RestError::from_kernel(console_kernel_core::KernelError::forbidden(
                "payroll read is unavailable",
            ))
        })?;
    if !allowed {
        return Err(RestError::from_kernel(
            console_kernel_core::KernelError::forbidden(
                "payroll read requires tenant pay:view access",
            ),
        ));
    }
    Ok(())
}
