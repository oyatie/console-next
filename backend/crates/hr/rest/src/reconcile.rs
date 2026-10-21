//! 이관 확인 routes (BE-EMP-UI; spec E7-reconcile, E7-row, E7-signoff). The
//! gates are in the service (`employee_directory_manage` org-wide).

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post, put};
use axum::{Extension, Json, Router};
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::import::reconcile::ImportSignoff;
use console_hr_adapter_postgres::import::reconcile::{ImportReconcile, ReconcileRowsQuery};
use console_hr_adapter_postgres::import::reconcile_rows::{ReconcileRow, ReconcileRowPage};
use console_hr_adapter_postgres::import::reconcile_write::{
    SetReconcileCheckRequest, SignOffImportRequest,
};
use console_platform_authz::Principal;
use uuid::Uuid;

use crate::HrApiError;

pub const RECONCILE_PATH_TEMPLATE: &str = "/api/v1/employees/import/{run_id}/reconcile";
pub const RECONCILE_ROWS_PATH_TEMPLATE: &str = "/api/v1/employees/import/{run_id}/reconcile/rows";
pub const RECONCILE_ROW_PATH_TEMPLATE: &str =
    "/api/v1/employees/import/{run_id}/reconcile/rows/{source_key}";
pub const SIGNOFF_PATH_TEMPLATE: &str = "/api/v1/employees/import/{run_id}/signoff";
pub const RECONCILE_ROUTE_PATHS: &[&str] = &[
    RECONCILE_PATH_TEMPLATE,
    RECONCILE_ROWS_PATH_TEMPLATE,
    RECONCILE_ROW_PATH_TEMPLATE,
    SIGNOFF_PATH_TEMPLATE,
];

pub fn router(service: HrService) -> Router {
    Router::new()
        .route(RECONCILE_PATH_TEMPLATE, get(reconcile))
        .route(RECONCILE_ROWS_PATH_TEMPLATE, get(rows))
        .route(RECONCILE_ROW_PATH_TEMPLATE, put(check))
        .route(SIGNOFF_PATH_TEMPLATE, post(sign_off))
        .with_state(service)
}

async fn reconcile(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(run_id): Path<Uuid>,
) -> Result<Json<ImportReconcile>, HrApiError> {
    Ok(Json(service.import_reconcile(principal, run_id).await?))
}

async fn rows(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(run_id): Path<Uuid>,
    Query(query): Query<ReconcileRowsQuery>,
) -> Result<Json<ReconcileRowPage>, HrApiError> {
    Ok(Json(
        service
            .import_reconcile_rows(principal, run_id, query)
            .await?,
    ))
}

async fn check(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path((run_id, source_key)): Path<(Uuid, String)>,
    Json(body): Json<SetReconcileCheckRequest>,
) -> Result<Json<ReconcileRow>, HrApiError> {
    Ok(Json(
        service
            .set_import_reconcile_check(principal, run_id, source_key, body)
            .await?,
    ))
}

async fn sign_off(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(run_id): Path<Uuid>,
    Json(body): Json<SignOffImportRequest>,
) -> Result<(StatusCode, Json<ImportSignoff>), HrApiError> {
    let done = service.sign_off_import(principal, run_id, body).await?;
    Ok((StatusCode::CREATED, Json(done)))
}
