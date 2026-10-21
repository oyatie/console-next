//! IMPORT lane routes (BW-19 재입사). INTEG registers `INTAKE_ROUTE_PATHS` in
//! `CONFIGURED_ROUTE_SURFACES` and merges `router`.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Extension, Json, Router};
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::directory::create_rehire_input::RehireEmployeeRequest;
use console_hr_adapter_postgres::directory::types::EmployeeDetailResponse;
use console_platform_authz::Principal;
use uuid::Uuid;

use crate::HrApiError;

pub const EMPLOYEE_REHIRE_PATH_TEMPLATE: &str = "/api/v1/employees/{id}/rehire";
pub const INTAKE_ROUTE_PATHS: &[&str] = &[EMPLOYEE_REHIRE_PATH_TEMPLATE];

pub fn router(service: HrService) -> Router {
    Router::new()
        .route(EMPLOYEE_REHIRE_PATH_TEMPLATE, post(rehire_employee))
        .with_state(service)
}

/// 201 with the employee on the new period; 200 on an idempotent replay.
async fn rehire_employee(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(employee_id): Path<Uuid>,
    Json(body): Json<RehireEmployeeRequest>,
) -> Result<(StatusCode, Json<EmployeeDetailResponse>), HrApiError> {
    let (replayed, detail) = service
        .rehire_employee(principal, employee_id, body)
        .await?;
    let status = if replayed {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((status, Json(detail)))
}
