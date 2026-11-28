//! Identity and authorization: the org directory/identity routes, the Cedar
//! policy authoring routes, and tenant roles and grants (decision #26).

use axum::Router;
use console_identity_adapter_postgres::PgOrgStore;
use console_identity_rest::IdentityRestState;
use console_onboarding_adapter_postgres::PgOnboardingStore;
use console_platform_access::AccessService;
use console_platform_access_rest::AccessRestState;
use console_platform_authz_rest::{CedarPolicyRestState, PgCedarPolicyStore};
use console_platform_provisioning::BootstrapCredentialStore;

use super::TenantDeps;

pub(super) fn mount(router: Router, deps: &TenantDeps<'_>) -> Router {
    let (state, pool) = (deps.state, deps.pool);
    let identity = IdentityRestState::new(
        PgOrgStore::new(pool.clone()),
        state.jwt_verifier.clone(),
        PgOnboardingStore::new(pool.clone()),
    )
    .with_passkey_step_up(state.policy_step_up.clone())
    .with_documents_served(cfg!(feature = "docs"));
    #[cfg(feature = "analytics-quant")]
    let identity = identity
        .with_projection_access(|p| console_analytics_quant_rest::projection_access(p).is_ok());
    #[cfg(feature = "integrity")]
    let identity = identity.with_integrity_access(|principal| {
        use console_integrity::rest::{authorize_integrity_read, authorize_integrity_triage};
        (
            authorize_integrity_read(principal).is_ok(),
            authorize_integrity_triage(principal).is_ok(),
        )
    });
    #[cfg(feature = "evaluation")]
    let identity = identity
        .with_evaluation_tasks(console_evaluation_rest::my_tasks_available)
        .with_evaluation_cycles(console_evaluation_rest::cycle_access);
    #[cfg(feature = "workspace")]
    let identity = identity.with_calendar_access(crate::collaboration::calendar_access);
    #[cfg(feature = "consulting")]
    let identity = identity.with_consulting_access(console_consulting_rest::consulting_access);
    #[cfg(feature = "benefit")]
    let identity = identity.with_benefit_access(console_benefit_rest::catalog_access);
    #[cfg(feature = "compliance")]
    let identity = identity
        .with_ledger_access(console_compliance_rest::consent_ledger_available)
        .with_compliance_access(console_compliance_rest::catalog_access);
    router
        .merge(console_identity_rest::router(identity))
        .merge(console_platform_authz_rest::router(
            CedarPolicyRestState::new(
                PgCedarPolicyStore::new(pool.clone()),
                state.jwt_verifier.clone(),
            ),
        ))
        .merge(console_platform_access_rest::router(AccessRestState::new(
            {
                let service = AccessService::new(pool.clone(), state.policy_step_up.clone());
                match state.otp_hmac_key.clone() {
                    Some(key) => {
                        service.with_bootstrap_credentials(BootstrapCredentialStore::new(key))
                    }
                    None => service,
                }
            },
            state.jwt_verifier.clone(),
        )))
}
