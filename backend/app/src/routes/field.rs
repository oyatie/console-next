//! Field operations: dispatch, work orders and the mobile surface, equipment
//! registry and 3R, inspection, inventory, logistics, facilities and
//! production (one mount each).

use axum::Router;

use super::TenantDeps;

#[cfg(feature = "dispatch")]
pub(super) fn mount_dispatch(router: Router, deps: &TenantDeps<'_>) -> Router {
    let state = deps.state;
    router.merge(console_dispatch_rest::router(
        console_dispatch_rest::DispatchRestState::new(
            console_dispatch_adapter_postgres::PgDispatchStore::new(deps.pool.clone()),
            state.jwt_verifier.clone(),
            state.config.dispatch_timers,
            state.dispatch_job_queue.clone(),
            state.push_notifier.clone(),
        ),
    ))
}

#[cfg(feature = "logistics")]
pub(super) fn mount_logistics(router: Router, deps: &TenantDeps<'_>) -> Router {
    router.merge(console_logistics_rest::router(
        console_logistics_rest::LogisticsRestState::new(
            console_logistics_adapter_postgres::PgLogisticsStore::new(deps.pool.clone()),
            deps.state.jwt_verifier.clone(),
        ),
    ))
}

#[cfg(feature = "inventory")]
pub(super) fn mount_inventory(router: Router, deps: &TenantDeps<'_>) -> Router {
    router.merge(console_inventory_rest::router(
        console_inventory_rest::InventoryRestState::new(
            console_inventory_adapter_postgres::PgInventoryStore::new(deps.pool.clone()),
            deps.state.jwt_verifier.clone(),
        ),
    ))
}

#[cfg(feature = "equipment")]
pub(super) fn mount_equipment(router: Router, deps: &TenantDeps<'_>) -> Router {
    router.merge(console_equipment_rest::router(
        console_equipment_rest::EquipmentRestState::new(
            console_equipment_adapter_postgres::PgEquipment3rStore::new(deps.pool.clone()),
            deps.state.jwt_verifier.clone(),
        ),
    ))
}

#[cfg(feature = "inspection")]
pub(super) fn mount_inspection(router: Router, deps: &TenantDeps<'_>) -> Router {
    router.merge(console_inspection_rest::router(
        console_inspection_rest::InspectionRestState::new(
            console_inspection_adapter_postgres::PgInspectionStore::new(deps.pool.clone()),
            deps.state.jwt_verifier.clone(),
        ),
    ))
}

#[cfg(feature = "registry")]
pub(super) fn mount_registry(router: Router, deps: &TenantDeps<'_>) -> Router {
    router.merge(console_registry_rest::router(
        console_registry_rest::RegistryRestState::new(
            console_registry_adapter_postgres::PgRegistryStore::new(deps.pool.clone()),
            deps.state.jwt_verifier.clone(),
        )
        .with_passkey_step_up(deps.state.policy_step_up.clone()),
    ))
}

/// Work orders and the mobile surface, over one work-order store whose
/// created-listener posts into the messenger.
#[cfg(feature = "workorder")]
pub(super) fn mount_workorder(router: Router, deps: &TenantDeps<'_>) -> Router {
    use console_workflow_runtime_adapter_postgres::PgWorkflowRuntimeStore;
    use console_workorder_rest::{MobileRestState, WorkOrderRestState};
    let (state, pool) = (deps.state, deps.pool);
    let work_order_store = console_workorder_adapter_postgres::PgWorkOrderStore::new(pool.clone())
        .with_created_listener(std::sync::Arc::new(super::messenger_store(pool)));
    router
        .merge(console_workorder_rest::router(
            WorkOrderRestState::new(work_order_store.clone(), state.jwt_verifier.clone())
                .with_workflow_runtime(Some(PgWorkflowRuntimeStore::new(pool.clone()))),
        ))
        .merge(console_workorder_rest::mobile_router(
            MobileRestState::new(
                pool.clone(),
                work_order_store,
                state.jwt_verifier.clone(),
                state.evidence_storage.clone(),
            )
            .with_passkey_step_up(state.policy_step_up.clone())
            .with_workflow_runtime(Some(PgWorkflowRuntimeStore::new(pool.clone())))
            .with_job_queue(state.dispatch_job_queue.clone()),
        ))
}

#[cfg(feature = "facilities")]
pub(super) fn mount_facilities(router: Router, deps: &TenantDeps<'_>) -> Router {
    router.merge(console_facilities_rest::router(
        console_facilities_rest::FacilitiesRestState::new(
            deps.pool.clone(),
            deps.state.jwt_verifier.clone(),
        ),
    ))
}

#[cfg(feature = "production")]
pub(super) fn mount_production(router: Router, deps: &TenantDeps<'_>) -> Router {
    let state = deps.state;
    router.merge(console_production_rest::router(
        console_production_rest::ProductionRestState::new(
            deps.pool.clone(),
            state.jwt_verifier.clone(),
        )
        .with_service_principal_hmac_key(state.config.production_service_principal_hmac_key),
    ))
}
