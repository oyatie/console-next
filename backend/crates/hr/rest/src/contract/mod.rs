//! G1 contract history routes. Recording requires an `Idempotency-Key` (a
//! UUID); a replay answers 200 with the stored row, a new row 201.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::get;
use axum::{Extension, Json, Router};
use console_hr_adapter_postgres::contract::{ContractList, ContractView, RecordContractRequest};
use console_hr_adapter_postgres::{HrError, HrService};
use console_platform_authz::Principal;
use uuid::Uuid;

use crate::HrApiError;

pub const CONTRACTS_PATH_TEMPLATE: &str = "/api/v1/employees/{id}/contracts";
pub const CONTRACT_ROUTE_PATHS: &[&str] = &[CONTRACTS_PATH_TEMPLATE];

pub fn router(service: HrService) -> Router {
    Router::new()
        .route(
            CONTRACTS_PATH_TEMPLATE,
            get(list_contracts).post(record_contract),
        )
        .with_state(service)
}

fn idempotency_key(headers: &HeaderMap) -> Result<Uuid, HrApiError> {
    headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| Uuid::parse_str(value.trim()).ok())
        .ok_or_else(|| HrApiError(HrError::validation("Idempotency-Key header must be a UUID")))
}

async fn list_contracts(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(employee_id): Path<Uuid>,
) -> Result<Json<ContractList>, HrApiError> {
    Ok(Json(
        service.employee_contracts(principal, employee_id).await?,
    ))
}

async fn record_contract(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(employee_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<RecordContractRequest>,
) -> Result<(StatusCode, Json<ContractView>), HrApiError> {
    let key = idempotency_key(&headers)?;
    let (view, created) = service
        .record_contract(principal, employee_id, key, request)
        .await?;
    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(view)))
}
