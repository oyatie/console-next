//! Identity and authorization: the org directory/identity routes, the Cedar
//! policy authoring routes, and tenant roles and grants (decision #26).

use axum::Router;
use console_identity_adapter_postgres::PgOrgStore;
use console_identity_rest::IdentityRestState;
use console_onboarding_adapter_postgres::PgOnboardingStore;
use console_platform_access::AccessService;
use console_platform_access_rest::AccessRestState;
use console_platform_authz_rest::{CedarPolicyRestState, PgCedarPolicyStore};

use super::TenantDeps;

pub(super) fn mount(router: Router, deps: &TenantDeps<'_>) -> Router {
    let (state, pool) = (deps.state, deps.pool);
    router
        .merge(console_identity_rest::router(
            IdentityRestState::new(
                PgOrgStore::new(pool.clone()),
                state.jwt_verifier.clone(),
                PgOnboardingStore::new(pool.clone()),
            )
            .with_passkey_step_up(state.policy_step_up.clone())
            .with_documents_served(cfg!(feature = "docs")),
        ))
        .merge(console_platform_authz_rest::router(
            CedarPolicyRestState::new(
                PgCedarPolicyStore::new(pool.clone()),
                state.jwt_verifier.clone(),
            ),
        ))
        .merge(console_platform_access_rest::router(AccessRestState::new(
            AccessService::new(pool.clone(), state.policy_step_up.clone()),
            state.jwt_verifier.clone(),
        )))
}
