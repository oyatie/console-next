// SPDX-License-Identifier: LicenseRef-Proprietary
//! Operator self-profile uses platform authentication and the same validated, audited profile command.
use crate::{IdentityRestState, error::RestError, users::dto::UpdateSelfRequest};
use axum::{Extension, Json, Router, extract::State, routing::get};
use console_identity_application::{UpdateSelfProfileCommand, UserSummary};
use console_kernel_core::{BranchScope, OrgId, TraceContext};
use console_platform_authz::PlatformPrincipal;
use console_platform_request_context::{scope_org, with_platform_context};

pub(crate) fn router(state: IdentityRestState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.pool().clone();
    with_platform_context(
        Router::new()
            .route(crate::PLATFORM_ME_PATH, get(read).patch(update))
            .with_state(state),
        verifier,
        pool,
    )
}

async fn read(
    State(state): State<IdentityRestState>,
    Extension(actor): Extension<PlatformPrincipal>,
) -> Result<Json<UserSummary>, RestError> {
    scope_org(OrgId::platform(), async {
        state
            .store
            .get_user(actor.user_id, &BranchScope::All)
            .await
            .map(Json)
            .map_err(RestError::from_store)
    })
    .await
}

async fn update(
    State(state): State<IdentityRestState>,
    Extension(actor): Extension<PlatformPrincipal>,
    Json(body): Json<UpdateSelfRequest>,
) -> Result<Json<UserSummary>, RestError> {
    scope_org(OrgId::platform(), async {
        state
            .store
            .update_self_profile(UpdateSelfProfileCommand {
                user_id: actor.user_id,
                display_name: body.display_name,
                phone: body.phone,
                trace: TraceContext::generate(),
                occurred_at: time::OffsetDateTime::now_utc(),
            })
            .await
            .map(Json)
            .map_err(RestError::from_store)
    })
    .await
}
