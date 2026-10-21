//! BW-17 change-request routes. Lane PEOPLE-A. INTEG mounts [`router`] inside
//! the authenticated HR router (the `Principal` extension comes from there)
//! and registers [`CHANGE_REQUESTS_ROUTE_PATHS`].

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::requests::{
    ChangeRequestListQuery, ChangeRequestPage, ChangeRequestResponse, CreateChangeRequest,
    DecideChangeRequest,
};
use console_platform_authz::Principal;
use uuid::Uuid;

use crate::HrApiError;

pub const CHANGE_REQUESTS_PATH: &str = "/api/v1/change-requests";
pub const CHANGE_REQUEST_DECIDE_PATH: &str = "/api/v1/change-requests/{id}/decide";
pub const CHANGE_REQUESTS_ROUTE_PATHS: &[&str] =
    &[CHANGE_REQUESTS_PATH, CHANGE_REQUEST_DECIDE_PATH];

pub fn router(hr: HrService) -> Router {
    Router::new()
        .route(CHANGE_REQUESTS_PATH, get(list).post(create))
        .route(CHANGE_REQUEST_DECIDE_PATH, post(decide))
        .with_state(hr)
}

async fn list(
    State(hr): State<HrService>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<ChangeRequestListQuery>,
) -> Result<Json<ChangeRequestPage>, HrApiError> {
    Ok(Json(hr.list_change_requests(principal, query).await?))
}

async fn create(
    State(hr): State<HrService>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<CreateChangeRequest>,
) -> Result<(StatusCode, Json<ChangeRequestResponse>), HrApiError> {
    let created = hr.create_change_request(principal, body).await?;
    Ok((StatusCode::CREATED, Json(created)))
}

async fn decide(
    State(hr): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
    Json(body): Json<DecideChangeRequest>,
) -> Result<Json<ChangeRequestResponse>, HrApiError> {
    let holders = crate::corrections::holders::second_person_context(&hr, &principal, None).await?;
    Ok(Json(
        hr.decide_change_request(principal, id, body, holders)
            .await?,
    ))
}
