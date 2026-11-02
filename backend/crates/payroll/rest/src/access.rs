// SPDX-License-Identifier: LicenseRef-Proprietary
//! Payroll decisions share the canonical fact loader and the data transaction.
use console_kernel_core::{OrgId, UserId};
use console_platform_authz::Feature;
use console_platform_authz::access::{NodeKind, NodeRef};
use console_platform_authz::cedar_pbac::visible::load_facts;
use sqlx::{Postgres, Transaction};

use axum::http::HeaderMap;
use console_platform_authz::Principal;

use crate::{PageParams, PayrollRestState, RestError, list_runs_page};
use console_payroll_adapter_postgres::PayrollRunSummary;

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

pub(crate) async fn principal_from_headers(
    state: &PayrollRestState,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let verifier = state.jwt_verifier.as_ref().ok_or_else(|| {
        RestError::unavailable("JWT verification is not configured for the payroll API")
    })?;
    console_platform_request_context::resolve_principal(verifier, state.store.pool(), headers)
        .await
        .map_err(crate::rest_error_from_request_context)
}

pub(crate) async fn require_module(
    state: &PayrollRestState,
    headers: &HeaderMap,
) -> Result<(), RestError> {
    let principal = principal_from_headers(state, headers).await?;
    let store = state.store.clone();
    let (org, actor) = (principal.org_id, principal.user_id);
    console_platform_db::with_org_conn::<_, _, RestError>(state.store.pool(), org, move |tx| {
        Box::pin(async move {
            console_platform_authz::cedar_pbac::visible::require_payroll_module(
                tx,
                org,
                *actor.as_uuid(),
                &store,
            )
            .await
            .map_err(RestError::from_kernel)
        })
    })
    .await
}

pub(crate) async fn module_gate(
    axum::extract::State(state): axum::extract::State<PayrollRestState>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<axum::response::Response, RestError> {
    require_module(&state, request.headers()).await?;
    Ok(next.run(request).await)
}

impl PayrollRestState {
    /// SSR composition helper: the same `PayrollRunRead` listing as GET `/runs`,
    /// or an empty vec (omit) when the caller is unauthenticated, unauthorized,
    /// or the listing fails. Never a 401/403 on the HTML shell.
    pub async fn visible_run_summaries(&self, headers: &HeaderMap) -> Vec<PayrollRunSummary> {
        if require_module(self, headers).await.is_err() {
            return Vec::new();
        }
        match list_runs_page(
            self,
            headers,
            PageParams {
                limit: Some(100),
                offset: Some(0),
            },
        )
        .await
        {
            Ok(page) => page.items,
            Err(_) => Vec::new(),
        }
    }
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
