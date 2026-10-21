//! BW-38 change set routes: the caller's draft per intent, its lines, the
//! atomic commit (Idempotency-Key required) and discard.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{delete, get, post};
use axum::{Extension, Json, Router};
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::change_sets::{
    ChangeSetDetail, ChangeSetLine, ChangeSetSummary, CommitChangeSetRequest,
    IDEMPOTENCY_KEY_HEADER, OpenChangeSetRequest, PutChangeSetLineRequest,
};
use console_platform_authz::Principal;
use serde_json::Value;
use uuid::Uuid;

use crate::HrApiError;

pub const CHANGE_SETS_PATH: &str = "/api/v1/change-sets";
pub const CHANGE_SET_PATH_TEMPLATE: &str = "/api/v1/change-sets/{id}";
pub const CHANGE_SET_LINES_PATH_TEMPLATE: &str = "/api/v1/change-sets/{id}/lines";
pub const CHANGE_SET_LINE_PATH_TEMPLATE: &str = "/api/v1/change-sets/{id}/lines/{line_id}";
pub const CHANGE_SET_COMMIT_PATH_TEMPLATE: &str = "/api/v1/change-sets/{id}/commit";
pub const CHANGE_SET_ROUTE_PATHS: &[&str] = &[
    CHANGE_SETS_PATH,
    CHANGE_SET_PATH_TEMPLATE,
    CHANGE_SET_LINES_PATH_TEMPLATE,
    CHANGE_SET_LINE_PATH_TEMPLATE,
    CHANGE_SET_COMMIT_PATH_TEMPLATE,
];

pub fn router(service: HrService) -> Router {
    Router::new()
        .route(CHANGE_SETS_PATH, post(open).get(list))
        .route(CHANGE_SET_PATH_TEMPLATE, get(detail).delete(discard))
        .route(CHANGE_SET_LINES_PATH_TEMPLATE, post(put_line))
        .route(CHANGE_SET_LINE_PATH_TEMPLATE, delete(remove_line))
        .route(CHANGE_SET_COMMIT_PATH_TEMPLATE, post(commit))
        .with_state(service)
}

async fn open(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<OpenChangeSetRequest>,
) -> Result<Json<ChangeSetDetail>, HrApiError> {
    Ok(Json(service.open_change_set(principal, body).await?))
}

async fn list(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<Vec<ChangeSetSummary>>, HrApiError> {
    Ok(Json(service.change_sets(principal).await?))
}

async fn detail(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
) -> Result<Json<ChangeSetDetail>, HrApiError> {
    Ok(Json(service.change_set(principal, id).await?))
}

async fn discard(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, HrApiError> {
    service.discard_change_set(principal, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn put_line(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
    Json(body): Json<PutChangeSetLineRequest>,
) -> Result<Json<ChangeSetLine>, HrApiError> {
    Ok(Json(
        service.put_change_set_line(principal, id, body).await?,
    ))
}

async fn remove_line(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path((id, line_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, HrApiError> {
    service
        .remove_change_set_line(principal, id, line_id)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn commit(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<CommitChangeSetRequest>,
) -> Result<Json<Value>, HrApiError> {
    let key = headers
        .get(IDEMPOTENCY_KEY_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    Ok(Json(
        service.commit_change_set(principal, id, key, body).await?,
    ))
}
