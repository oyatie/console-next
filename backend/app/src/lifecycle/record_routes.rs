// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{LifecycleState, get_lifecycle, set_lifecycle_hold, transition_lifecycle};
use axum::{
    Router,
    extract::Path,
    response::IntoResponse,
    routing::{get, post},
};

pub const LIFECYCLE_PATH_TEMPLATE: &str = "/api/v1/lifecycles/{objectType}/{objectId}";
pub const LIFECYCLE_TRANSITION_PATH_TEMPLATE: &str =
    "/api/v1/lifecycles/{objectType}/{objectId}/transition";
pub const LIFECYCLE_HOLD_PATH_TEMPLATE: &str = "/api/v1/lifecycles/{objectType}/{objectId}/hold";

pub(super) fn router(state: LifecycleState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.pool.clone();
    let records = Router::new()
        .route(LIFECYCLE_PATH_TEMPLATE, get(get_lifecycle))
        .route(
            LIFECYCLE_TRANSITION_PATH_TEMPLATE,
            post(transition_lifecycle),
        )
        .route(LIFECYCLE_HOLD_PATH_TEMPLATE, post(set_lifecycle_hold))
        .with_state(state);
    console_platform_request_context::with_request_context(records, verifier, pool)
        .layer(axum::middleware::from_fn(benefit_lifecycle_admission))
}

// The generic lifecycle routes can also address benefit items. Mark the decoded
// object type before the shared authentication and idempotency boundary.
async fn benefit_lifecycle_admission(
    Path((object_type, _)): Path<(String, String)>,
    mut request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    if object_type == "benefit_catalog_item" {
        if !cfg!(feature = "benefit") {
            return axum::http::StatusCode::NOT_FOUND.into_response();
        }
        request
            .extensions_mut()
            .insert(console_platform_request_context::tenant_module::TenantModule::Benefits);
    }
    next.run(request).await
}
