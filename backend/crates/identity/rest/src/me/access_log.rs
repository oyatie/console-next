// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{context::principal_from_headers, error::RestError, state::IdentityRestState};
use axum::{
    Json,
    extract::{Query, State},
    http::HeaderMap,
    response::IntoResponse,
};
use console_identity_application::MyAccessLogQuery;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub(crate) struct ListParams {
    cursor: Option<String>,
    limit: Option<i64>,
}

pub(crate) async fn list(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Query(params): Query<ListParams>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let page = state
        .store
        .list_my_access_log(
            &principal,
            MyAccessLogQuery {
                limit: params.limit,
                cursor: params.cursor,
            },
        )
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(page))
}
