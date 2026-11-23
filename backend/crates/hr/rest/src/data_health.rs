// SPDX-License-Identifier: LicenseRef-Proprietary
//! People data-health route (`GET /api/v1/hr/people/data-health`).

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Extension, Json, Router};
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::directory::data_health::{
    DataHealthQuery, PeopleDataHealthResponse,
};
use console_platform_authz::Principal;

use crate::HrApiError;

pub const PEOPLE_DATA_HEALTH_PATH: &str = "/api/v1/hr/people/data-health";
pub const DATA_HEALTH_ROUTE_PATHS: &[&str] = &[PEOPLE_DATA_HEALTH_PATH];

pub fn router(hr: HrService) -> Router {
    Router::new()
        .route(PEOPLE_DATA_HEALTH_PATH, get(get_data_health))
        .with_state(hr)
}

async fn get_data_health(
    State(hr): State<HrService>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<DataHealthQuery>,
) -> Result<Json<PeopleDataHealthResponse>, HrApiError> {
    Ok(Json(hr.people_data_health(principal, query).await?))
}
