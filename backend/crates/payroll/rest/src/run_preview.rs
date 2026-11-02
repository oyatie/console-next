// SPDX-License-Identifier: LicenseRef-Proprietary
use axum::{
    Json,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
};
use console_payroll_adapter_postgres::pay_groups::run_preview::{RunPreview, RunRequest};

use crate::{PayrollRestState, RestError, principal_from_headers};

pub(crate) async fn preview(
    State(state): State<PayrollRestState>,
    headers: HeaderMap,
    input: Result<Query<RunRequest>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<RunPreview>, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let Query(input) = input.map_err(|_| {
        RestError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation",
            "supply only pay_group_id and a valid run kind",
        )
    })?;
    state
        .store
        .preview_run(principal.org_id, principal.user_id, input)
        .await
        .map(Json)
        .map_err(RestError::from_store)
}
