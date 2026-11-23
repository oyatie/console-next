// SPDX-License-Identifier: LicenseRef-Proprietary
//! Unit position route for employee detail J/K navigation past 200 members.

use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Extension, Json, Router};
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::directory::read_unit_position::EmployeeUnitPosition;
use console_platform_authz::Principal;
use uuid::Uuid;

use crate::HrApiError;

pub const EMPLOYEE_UNIT_POSITION_PATH: &str = "/api/v1/employees/{id}/unit-position";
pub const UNIT_POSITION_ROUTE_PATHS: &[&str] = &[EMPLOYEE_UNIT_POSITION_PATH];

pub fn router(hr: HrService) -> Router {
    Router::new()
        .route(EMPLOYEE_UNIT_POSITION_PATH, get(read))
        .with_state(hr)
}

async fn read(
    State(hr): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
) -> Result<Json<EmployeeUnitPosition>, HrApiError> {
    Ok(Json(hr.employee_unit_position(principal, id).await?))
}
