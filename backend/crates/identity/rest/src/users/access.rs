// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{
    access_log, context::principal_from_headers, error::RestError, state::IdentityRestState,
};
use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use console_identity_application::UserSummary;
use console_kernel_core::UserId;
use uuid::Uuid;

pub(crate) async fn get_access_person(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<UserSummary>, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let summary = state
        .store
        .get_access_person(principal.user_id, UserId::from_uuid(id))
        .await
        .map_err(RestError::from_store)?;
    access_log::record_account_read(state.pool(), &principal, &summary).await?;
    Ok(Json(summary))
}
