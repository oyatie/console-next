// SPDX-License-Identifier: LicenseRef-Proprietary
//! HTTP boundary; the store owns Cedar, validation and audit in one transaction.
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::get,
};
use console_payroll_adapter_postgres::pay_groups::{CreatePayGroup, PayGroup, PayGroupPage};

use crate::{PayrollRestState, RestError, principal_from_headers};

pub const PAYROLL_PAY_GROUPS_PATH: &str = "/api/v1/payroll/pay-groups";

pub(crate) fn router() -> Router<PayrollRestState> {
    Router::new().route(PAYROLL_PAY_GROUPS_PATH, get(list).post(create))
}

async fn list(
    State(state): State<PayrollRestState>,
    headers: HeaderMap,
) -> Result<Json<PayGroupPage>, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let page = state
        .store
        .list_pay_groups(principal.org_id, principal.user_id)
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(page))
}

async fn create(
    State(state): State<PayrollRestState>,
    headers: HeaderMap,
    body: Result<Json<CreatePayGroup>, axum::extract::rejection::JsonRejection>,
) -> Result<(StatusCode, Json<PayGroup>), RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let Json(input) = body.map_err(|_| {
        RestError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation",
            "all pay-group choices must be explicitly supplied with valid types",
        )
    })?;
    let group = state
        .store
        .create_pay_group(principal.org_id, principal.user_id, input)
        .await
        .map_err(RestError::from_store)?;
    Ok((StatusCode::CREATED, Json(group)))
}
