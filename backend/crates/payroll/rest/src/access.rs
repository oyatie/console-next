// SPDX-License-Identifier: LicenseRef-Proprietary
//! Payroll decisions share the canonical fact loader and the data transaction.
use console_kernel_core::{OrgId, UserId};
use console_platform_authz::Feature;
use console_platform_authz::access::{NodeKind, NodeRef};
use console_platform_authz::cedar_pbac::visible::{DecisionFacts, load_facts};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use axum::http::{HeaderMap, StatusCode};
use console_payroll_adapter_postgres::pay_groups::{RlsPayGroupFacts, run_pay_group_in_tx};
use console_payroll_adapter_postgres::{PayrollRunSummary, PgPayrollStore};
use console_platform_auth::JwtVerifier;
use console_platform_authz::Principal;

use crate::{PageParams, PayrollRestState, RestError, list_runs_page};

/// Tenant pay access, then the run's pay group. A run the caller may not read
/// answers exactly as one that does not exist, before any body is validated, so
/// no request can tell the two apart; one they may read but not manage refuses
/// its commands.
pub(crate) async fn require_run_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    feature: Feature,
    run_id: Uuid,
) -> Result<(), RestError> {
    let facts = require_pay_action_in_tx(tx, org, actor, feature).await?;
    let not_found = || RestError::new(StatusCode::NOT_FOUND, "not_found", "run not found");
    let Some(group) = run_pay_group_in_tx(tx, run_id)
        .await
        .map_err(RestError::from_store)?
        .ok_or_else(not_found)?
    else {
        return Ok(());
    };
    let allowed = visible_pay_groups(tx, &facts, feature).await?;
    if allowed.contains(&group) {
        return Ok(());
    }
    let read = Feature::PayrollRunRead;
    if feature != read && visible_pay_groups(tx, &facts, read).await?.contains(&group) {
        return Err(RestError::from_kernel(
            console_kernel_core::KernelError::forbidden(
                "payroll run commands require sensitive:edit for this pay group",
            ),
        ));
    }
    Err(not_found())
}

/// The pay groups whose runs the caller may act on with `feature`.
pub(crate) async fn visible_pay_groups(
    tx: &mut Transaction<'_, Postgres>,
    facts: &DecisionFacts,
    feature: Feature,
) -> Result<Vec<Uuid>, RestError> {
    facts
        .visible_pay_groups(tx, feature, &RlsPayGroupFacts)
        .await
        .map_err(RestError::from_kernel)
}

pub(crate) async fn require_pay_action_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    feature: Feature,
) -> Result<DecisionFacts, RestError> {
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
    Ok(facts)
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
    #[must_use]
    pub fn new(store: PgPayrollStore, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self {
            store,
            jwt_verifier,
        }
    }

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
