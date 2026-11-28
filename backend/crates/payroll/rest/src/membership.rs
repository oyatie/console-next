// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{PayrollRestState, RestError, principal_from_headers};
use axum::{
    Json, Router,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    routing::get,
};
use console_payroll_adapter_postgres::pay_groups::membership::{
    AssignMembership, MembershipCandidate, MembershipSearch,
};
use serde_json::{Value, json};

pub(super) const PATH: &str = "/api/v1/payroll/pay-group-memberships";

pub(super) fn router() -> Router<PayrollRestState> {
    Router::new().route(PATH, get(search).post(assign))
}

async fn search(
    State(state): State<PayrollRestState>,
    headers: HeaderMap,
    Query(query): Query<MembershipSearch>,
) -> Result<Json<Vec<MembershipCandidate>>, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    Ok(Json(
        state
            .store
            .membership_candidates(principal.org_id, principal.user_id, query)
            .await
            .map_err(RestError::from_store)?,
    ))
}

async fn assign(
    State(state): State<PayrollRestState>,
    headers: HeaderMap,
    body: Result<Json<AssignMembership>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let Json(input) = body.map_err(|_| {
        RestError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation",
            "a dated employee, target and expected source are required",
        )
    })?;
    let id = input.pay_group_id;
    state
        .store
        .assign_membership(principal.org_id, principal.user_id, input)
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(json!({"id": id})))
}
