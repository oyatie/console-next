// SPDX-License-Identifier: LicenseRef-Proprietary
//! Employee import history, behind the import's org-wide management gate.

use axum::extract::{Path, Query, State};
use axum::routing::get;
use axum::{Extension, Json, Router};
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::import::run_record::{
    EmployeeImportRun, EmployeeImportRunPage, RunListQuery,
};
use console_platform_authz::Principal;
use uuid::Uuid;

use crate::HrApiError;

pub const IMPORT_RUNS_PATH: &str = "/api/v1/employee-import-runs";
pub const IMPORT_RUN_PATH: &str = "/api/v1/employee-import-runs/{run_id}";
pub const IMPORT_RUN_ROUTE_PATHS: &[&str] = &[IMPORT_RUNS_PATH, IMPORT_RUN_PATH];

pub fn router(service: HrService) -> Router {
    Router::new()
        .route(IMPORT_RUNS_PATH, get(list))
        .route(IMPORT_RUN_PATH, get(record))
        .with_state(service)
}

async fn list(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<RunListQuery>,
) -> Result<Json<EmployeeImportRunPage>, HrApiError> {
    Ok(Json(service.import_runs(principal, query).await?))
}

async fn record(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(run_id): Path<Uuid>,
) -> Result<Json<EmployeeImportRun>, HrApiError> {
    Ok(Json(service.import_run(principal, run_id).await?))
}
