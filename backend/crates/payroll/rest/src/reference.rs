// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{PayrollRestState, RestError, principal_from_headers};
use axum::{
    Json,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
};
use console_payroll_adapter_postgres::reference::PayrollRates;
use serde::Deserialize;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RatesQuery {
    legal_entity_id: Uuid,
}

pub(crate) async fn list(
    State(state): State<PayrollRestState>,
    headers: HeaderMap,
    input: Result<Query<RatesQuery>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<PayrollRates>, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let Query(input) = input.map_err(|_| {
        RestError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation",
            "supply only legal_entity_id as a UUID",
        )
    })?;
    state
        .store
        .reference_rates(principal.org_id, principal.user_id, input.legal_entity_id)
        .await
        .map(Json)
        .map_err(RestError::from_store)
}
