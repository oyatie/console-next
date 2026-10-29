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
    require_pay_action_in_tx(tx, org, actor, Feature::PayrollRunRead).await
}

pub(crate) async fn require_pay_action_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    feature: Feature,
) -> Result<(), RestError> {
    let facts = load_facts(tx, org, *actor.as_uuid())
        .await
        .map_err(RestError::from_kernel)?;
    // Runs have no legal-entity scope yet; narrower grants cannot disclose tenant totals.
    let allowed = facts
        .authorize(
            feature.as_str(),
            NodeRef {
                kind: NodeKind::Tenant,
                id: *org.as_uuid(),
            },
        )
        .map_err(cedar_error)?;
    if !allowed {
        return Err(RestError::from_kernel(
            console_kernel_core::KernelError::forbidden(
                "payroll action requires tenant pay access",
            ),
        ));
    }
    Ok(())
}

fn cedar_error(error: console_platform_authz::access::AccessEngineError) -> RestError {
    tracing::error!(%error, "payroll Cedar decision failed");
    RestError::unavailable("payroll access decision is unavailable")
}

#[cfg(test)]
mod tests {
    use super::*;
    use console_platform_authz::access::AccessEngineError;

    #[test]
    fn cedar_engine_errors_are_unavailable_not_permission_denials() {
        for error in [
            AccessEngineError::Schema("invalid schema".into()),
            AccessEngineError::Compile("invalid policy".into()),
            AccessEngineError::Evaluation("engine failed".into()),
            AccessEngineError::FactMissing("missing fact".into()),
        ] {
            let response = cedar_error(error);
            assert_eq!(response.status, axum::http::StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(response.code, "unavailable");
        }
    }
}
