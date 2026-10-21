//! Governed-config seeder injected into the platform router.

use console_ontology_adapter_postgres::PgOntologyStore;
use std::sync::Arc;

/// Build the engine-backed governed-config catalog seeder injected into the
/// platform router. Runs once per newly onboarded tenant: it opens a
/// configured `PgOntologyStore` and drives the standard config object types
/// (SLO settings, console views) through the engine, scoped to the new org so the
/// registry writes pass FORCE-RLS. Lives here (App tier) because the platform tier
/// must not depend on the ontology adapter (layer boundary).
pub(crate) fn tenant_config_seeder(
    store: PgOntologyStore,
) -> console_platform_rest::TenantConfigSeeder {
    Arc::new(move |org, actor, at| {
        let store = store.clone();
        Box::pin(async move {
            console_platform_request_context::scope_org(
                org,
                console_ontology_adapter_postgres::seed::seed_governed_config_object_types(
                    &store, actor, at,
                ),
            )
            .await
            .map(|_| ())
            .map_err(|err| err.to_string())
        })
    })
}
