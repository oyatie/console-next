//! Projected dispatch registry for the ontology tier.

use console_kernel_core::{EquipmentId, KernelError, TraceContext};
use console_ontology_canonical_adapter_postgres::company::PgCompanyPort;
use console_ontology_canonical_adapter_postgres::employment::PgEmploymentPort;
use console_ontology_canonical_adapter_postgres::job_position::PgJobPositionPort;
use console_ontology_canonical_adapter_postgres::org_unit::PgOrgUnitPort;
use console_ontology_canonical_adapter_postgres::person::PgPersonPort;
use console_ontology_rest::{
    ActionError, ProjectedDispatch, ProjectedDispatchRegistry, ProjectedHandler,
};
use console_payroll_adapter_postgres::pay_run::PgPayRunPort;
use console_registry_adapter_postgres::{PgRegistryError, PgRegistryStore};
use console_registry_application::{UpdateEquipmentCommand, UpdateEquipmentFields};
use console_registry_domain::EquipmentStatus;
use sqlx::PgPool;
use std::sync::Arc;

/// Map a registry use-case error onto [`ActionError`] without touching the
/// ontology adapter's error type — the pattern every App-tier projected
/// handler follows.
fn registry_error_to_action_error(err: PgRegistryError) -> ActionError {
    match err {
        PgRegistryError::Domain(kernel) => ActionError::domain(kernel),
        PgRegistryError::Db(db) => ActionError::domain(KernelError::internal(db.to_string())),
        PgRegistryError::Workbook(message) => ActionError::domain(KernelError::internal(message)),
    }
}

/// `registry.update_equipment` projected dispatch: routes into the registry
/// crate's real `update_equipment` use-case (its own RLS + audit + versioning).
/// The ontology engine writes nothing of its own for this action (§9.3: no
/// second source of truth).
fn update_equipment_projected_handler(store: PgRegistryStore) -> ProjectedHandler {
    Arc::new(move |input: ProjectedDispatch| {
        let store = store.clone();
        Box::pin(async move {
            let equipment_uuid = input.target_id.ok_or_else(|| {
                ActionError::domain(KernelError::validation(
                    "update_equipment requires a target equipment id",
                ))
            })?;
            let status = input
                .params
                .get("status")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    ActionError::domain(KernelError::validation("status param is required"))
                })
                .and_then(|s| EquipmentStatus::parse(s).map_err(ActionError::domain))?;

            store
                .update_equipment(UpdateEquipmentCommand {
                    actor: input.principal.user_id,
                    // The projected dispatch is a second door onto the SAME
                    // use-case, so it carries the same branch scope; without it
                    // the ontology action would be a way around the check.
                    branch_scope: input.principal.branch_scope.clone(),
                    equipment_id: EquipmentId::from_uuid(equipment_uuid),
                    fields: UpdateEquipmentFields {
                        status: Some(status),
                        ..UpdateEquipmentFields::default()
                    },
                    trace: TraceContext::generate(),
                    occurred_at: input.occurred_at,
                })
                .await
                .map_err(registry_error_to_action_error)?;

            Ok(serde_json::json!({ "target": input.target, "target_id": equipment_uuid }))
        })
    })
}

/// The full projected-dispatch registry supplied to the ontology REST tier.
/// Unresolved targets fail closed (`NotWiredYet`) — see
/// `console_ontology_rest::ProjectedDispatchRegistry::dispatch`.
///
/// # Six lines for thirteen targets, and for the fourteenth
///
/// `register_port` is called once per canonical OBJECT, not once per action:
/// each call installs the port that owns every `dispatch_target` the contract
/// assigns to that object, so `hr.appoint`, `hr.promote` and `hr.transfer` are
/// one line between them. `ObjectKey` is LOCKED at six by
/// `six_projected_stable_object_keys_verbatim`, so this list is closed — a new
/// dispatch target lands in `dispatch_targets!` and in the owning port's query
/// enum, and needs no edit here at all. That is the whole point: the enumerable
/// thing is the one a contract test forbids from growing.
///
/// `registry.update_equipment` is not a roster member and keeps its hand-written
/// handler; it is the last of that shape.
pub(crate) fn projected_dispatch_registry(pool: PgPool) -> ProjectedDispatchRegistry {
    // Every port bridges a SYNCHRONOUS `execute` onto async `sqlx` with this
    // handle. `build_router` is only ever called from inside a runtime, and a
    // panic here is the correct failure: a router built without one would fail
    // every canonical action at request time instead of at startup.
    let runtime = tokio::runtime::Handle::current();
    ProjectedDispatchRegistry::new()
        .register(
            "registry.update_equipment",
            update_equipment_projected_handler(PgRegistryStore::new(pool.clone())),
        )
        .register_port(PgCompanyPort::new(pool.clone(), runtime.clone()))
        .register_port(PgOrgUnitPort::new(pool.clone(), runtime.clone()))
        .register_port(PgJobPositionPort::new(pool.clone(), runtime.clone()))
        .register_port(PgPersonPort::new(pool.clone(), runtime.clone()))
        .register_port(PgEmploymentPort::new(pool.clone(), runtime.clone()))
        .register_port(PgPayRunPort::new(pool, runtime))
}

/// The composition root is measured for COVERAGE, not for its shape: whatever
/// `dispatch_targets!` holds, the registry this crate hands the ontology tier
/// must resolve all of it. Names no target and no object, so a fourteenth
/// target is asserted the moment the contract declares one, and a dropped
/// `register_port` line is what makes it fail.
#[cfg(test)]
#[cfg(not(feature = "test-postgres"))]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod projected_dispatch_coverage {
    use console_ontology_canonical_domain::DispatchTarget;
    #[tokio::test]
    async fn company_legal_facts_are_refused_by_the_deployed_registry() {
        let pool =
            sqlx::postgres::PgPool::connect_lazy("postgres://console@127.0.0.1/console").unwrap();
        let error = super::projected_dispatch_registry(pool)
            .preflight(
                DispatchTarget::CompanyRevise,
                None,
                serde_json::json!({"attributes": {"legal_name": "COSS"}}),
            )
            .unwrap_err();
        let console_ontology_rest::ActionError::Store(
            console_ontology_adapter_postgres::PgOntologyError::Domain(error),
        ) = error
        else {
            panic!("expected a coded domain refusal: {error:?}");
        };
        assert_eq!(error.code, Some("legal_entity_record_required"));
        assert!(error.message.contains("/org/entities"));
    }
    #[tokio::test]
    async fn the_wired_registry_resolves_every_canonical_dispatch_target() {
        // Lazy: no connection is opened, and none is needed — resolution is a
        // property of the wiring, not of the database behind it.
        let pool = sqlx::postgres::PgPool::connect_lazy("postgres://console@127.0.0.1/console")
            .expect("a lazy pool never connects");
        let registry = super::projected_dispatch_registry(pool);

        let unresolved: Vec<&str> = DispatchTarget::ALL
            .iter()
            .filter(|target| !registry.resolves(**target))
            .map(|target| target.as_str())
            .collect();
        assert!(
            unresolved.is_empty(),
            "the deployed registry resolves no port for {unresolved:?}"
        );
    }
}
