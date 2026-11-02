// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{context::principal_from_headers, error::RestError, state::IdentityRestState};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use console_identity_adapter_postgres::IdempotentCreate;
use console_identity_application::EmployeeView;

pub(crate) async fn list(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let items = state
        .store
        .employee_views(principal.user_id)
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(serde_json::json!({"items": items})))
}

pub(crate) async fn create(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Json(body): Json<EmployeeView>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    if headers.get("Idempotency-Key").and_then(|v| v.to_str().ok())
        != Some(body.id.to_string().as_str())
    {
        return Err(RestError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "employee_view_key_mismatch",
            "Idempotency-Key must equal the view id",
        ));
    }
    let (status, stored) = match state
        .store
        .create_employee_view(principal.user_id, body)
        .await
        .map_err(RestError::from_store)?
    {
        IdempotentCreate::Created(value) => (StatusCode::CREATED, value),
        IdempotentCreate::Replay(value) => (StatusCode::OK, value),
    };
    Ok((status, Json(stored)))
}
