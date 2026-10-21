//! Organization and governance: settings, period locks, org-change and the
//! 법인 · 사업장 faces (the MVP), then compliance, integrity, evidence objects
//! and the ontology / governance / Policy-Studio engine (one mount each).

use std::sync::Arc;

use axum::Router;
use console_orgchange_adapter_postgres::PgOrgChangeStore;
use console_orgchange_rest::OrgChangeRestState;
use console_settings_adapter_postgres::PgSettingsStore;
use console_settings_rest::SettingsRestState;

use super::TenantDeps;
use crate::lifecycle;
use crate::wiring::orgchange_ports::{PgEmploymentTransferPort, PgOrgUnitWritePort};

pub(super) fn mount(router: Router, deps: &TenantDeps<'_>) -> Router {
    let (state, pool) = (deps.state, deps.pool);
    router
        // Settings registry + reason-code catalog (BW-00/07): reads for any
        // signed-in member; every write is a Cedar `enforce_action` call.
        .merge(console_settings_rest::router(SettingsRestState::new(
            PgSettingsStore::new(pool.clone()),
            state.jwt_verifier.clone(),
        )))
        // Period locks (BW-15): lock, unlock with a second person, relock.
        .merge(lifecycle::router(
            lifecycle::LifecycleState::new(pool.clone(), state.jwt_verifier.clone())
                .with_passkey_step_up(state.policy_step_up.clone()),
        ))
        // Org-change lifecycle engine (조직 개편 결재): draft → preflight
        // → ordered SoD approval → effective-dated apply (§15/§16).
        .merge(console_orgchange_rest::router(OrgChangeRestState::new(
            PgOrgChangeStore::new(pool.clone())
                .with_employment_transfer(Arc::new(PgEmploymentTransferPort))
                .with_org_unit_write(Arc::new(PgOrgUnitWritePort)),
            state.jwt_verifier.clone(),
        )))
        // 법인 · 사업장 + setup phase (운영 시작); composed in entity_wiring.rs.
        .merge(crate::entity_wiring::router(
            pool.clone(),
            state.jwt_verifier.clone(),
            state.policy_step_up.clone(),
            state.juso.clone(),
        ))
}

#[cfg(feature = "compliance")]
pub(super) fn mount_compliance(router: Router, deps: &TenantDeps<'_>) -> Router {
    router.merge(console_compliance_rest::router(
        console_compliance_rest::ComplianceRestState::new(
            console_compliance_adapter_postgres::PgComplianceStore::new(deps.pool.clone()),
            deps.state.jwt_verifier.clone(),
        ),
    ))
}

#[cfg(feature = "integrity")]
pub(super) fn mount_integrity(router: Router, deps: &TenantDeps<'_>) -> Router {
    router.merge(console_integrity::router(
        console_integrity::IntegrityRestState::new(
            console_integrity::PgIntegrityStore::new(deps.pool.clone()),
            deps.state.jwt_verifier.clone(),
        ),
    ))
}

/// Evidence-objects console surface (custody / fixity-verify / legal-hold).
/// The fixity check HEADs the WORM (replica) bucket; when object storage is
/// unconfigured the store is `None` and `verify` 503s rather than
/// green-lighting an unverifiable object.
#[cfg(feature = "docs")]
pub(super) fn mount_docs(router: Router, deps: &TenantDeps<'_>) -> Router {
    use console_platform_storage::S3ObjectStore;
    let (state, pool) = (deps.state, deps.pool);
    router.merge(console_docs_rest::router(
        console_docs_rest::DocsRestState::new(
            console_docs_adapter_postgres::PgDocsStore::new(pool.clone()),
            console_governance_adapter_postgres::PgGovernanceStore::new(pool.clone()),
            state
                .worm_evidence_storage
                .as_ref()
                .map(|(store, _)| Arc::new(store.clone()) as Arc<dyn S3ObjectStore>),
            state
                .worm_evidence_storage
                .as_ref()
                .map(|(_, bucket)| bucket.clone())
                .unwrap_or_default(),
            state.jwt_verifier.clone(),
        ),
    ))
}

/// Ontology engine surface. It self-applies four-eyes/governance gate chains;
/// its action-execute path is the single mutation surface (§16).
#[cfg(feature = "ontology")]
pub(super) fn mount_ontology(router: Router, deps: &TenantDeps<'_>) -> Router {
    let pool = deps.pool;
    router.merge(console_ontology_rest::router(
        console_ontology_rest::OntologyRestState::new(
            deps.ontology_registry_store.clone(),
            console_ontology_adapter_postgres::instances::PgInstanceStore::new(pool.clone()),
            console_governance_adapter_postgres::PgGovernanceStore::new(pool.clone()),
            deps.state.jwt_verifier.clone(),
        )
        .with_projected_dispatch(crate::wiring::dispatch::projected_dispatch_registry(
            pool.clone(),
        )),
    ))
}

#[cfg(feature = "governance")]
pub(super) fn mount_governance(router: Router, deps: &TenantDeps<'_>) -> Router {
    router.merge(console_governance_rest::router(
        console_governance_rest::GovernanceRestState::new(
            console_governance_adapter_postgres::PgGovernanceStore::new(deps.pool.clone()),
            deps.state.jwt_verifier.clone(),
        ),
    ))
}
