// SPDX-License-Identifier: LicenseRef-Proprietary

use super::{EQUIPMENT_IMPORT_PATH, MAX_IMPORT_BYTES, RegistryRestState, import_master_list};
use axum::{Router, routing::post};

pub(super) fn with_import_limit(router: Router, state: RegistryRestState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.store.pool().clone();
    let imports = Router::new()
        .route(EQUIPMENT_IMPORT_PATH, post(import_master_list))
        .with_state(state);
    console_platform_request_context::with_request_context(router, verifier.clone(), pool.clone())
        .merge(
            console_platform_request_context::with_request_context_body_limit(
                imports,
                verifier,
                pool,
                MAX_IMPORT_BYTES,
            ),
        )
}
