// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::HrApiError;
use axum::{
    Extension, Json, Router,
    extract::{Path, Query, State},
    routing::get,
};
use console_hr_adapter_postgres::{
    HrService,
    exits::preflight::{ExitGuardsQuery, ExitGuardsView},
};
use console_platform_authz::Principal;
use uuid::Uuid;
pub const EXIT_GUARDS_PATH: &str = "/api/v1/employees/{id}/exit-guards";
pub const EXIT_GUARDS_ROUTE_PATHS: &[&str] = &[EXIT_GUARDS_PATH];
pub fn router(service: HrService) -> Router {
    Router::new()
        .route(EXIT_GUARDS_PATH, get(read))
        .with_state(service)
}
async fn read(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
    Query(query): Query<ExitGuardsQuery>,
) -> Result<Json<ExitGuardsView>, HrApiError> {
    Ok(Json(
        service.employee_exit_guards(principal, id, query).await?,
    ))
}
