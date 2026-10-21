//! Workflow and workspace: the workflow studio and object context,
//! collaboration, the action inbox, the workbench and objects (one coupled
//! mount: these app modules call each other), and office.

use axum::Router;

use super::TenantDeps;

#[cfg(feature = "workspace")]
pub(super) fn mount_workspace(router: Router, deps: &TenantDeps<'_>) -> Router {
    use crate::{
        action_inbox, collaboration, objects, workbench, workbench_native, workflow_object_context,
        workflow_studio,
    };
    let (state, pool) = (deps.state, deps.pool);
    router
        .merge(workflow_studio::router(
            workflow_studio::WorkflowStudioState::new(pool.clone(), state.jwt_verifier.clone())
                .with_passkey_step_up(state.policy_step_up.clone()),
        ))
        .merge(workflow_object_context::router(
            workflow_object_context::WorkflowObjectContextState::new(
                pool.clone(),
                state.jwt_verifier.clone(),
            ),
        ))
        .merge(collaboration::router(
            collaboration::CollaborationState::new(pool.clone(), state.jwt_verifier.clone())
                .with_passkey_step_up(state.policy_step_up.clone()),
        ))
        .merge(action_inbox::router(action_inbox::ActionInboxState::new(
            pool.clone(),
            state.jwt_verifier.clone(),
        )))
        .merge(workbench::router(workbench::WorkbenchState::new(
            std::sync::Arc::new(workbench_native::NativeWorkbenchReaders::new(pool.clone())),
            pool.clone(),
            state.jwt_verifier.clone(),
        )))
        .merge(objects::router(objects::ObjectState::new(
            pool.clone(),
            state.jwt_verifier.clone(),
        )))
}

/// Office documents. Reuses the already-configured SeaweedFS handle (evidence /
/// sales media) as the office blob store — no new object-store client. `None`
/// blobs ⇒ office endpoints 503, like mail.
#[cfg(feature = "office")]
pub(super) fn mount_office(router: Router, deps: &TenantDeps<'_>) -> Router {
    use crate::office;
    let state = deps.state;
    let office_blobs = match (&state.config.office, &state.sales_media_storage) {
        (Some(cfg), Some((store, bucket))) => {
            office::OfficeState::seaweed_blobs(cfg, store.clone(), bucket.clone())
        }
        _ => None,
    };
    router.merge(office::router(office::OfficeState::new(
        deps.pool.clone(),
        state.jwt_verifier.clone(),
        state.config.office.clone(),
        office_blobs,
    )))
}
