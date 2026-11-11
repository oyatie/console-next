//! Fields a tenant adds to its personnel card: their definitions.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, patch};
use axum::{Extension, Json, Router};
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::roster_field::{
    CreateRosterFieldRequest, RosterFieldList, RosterFieldView, UpdateRosterFieldRequest,
};
use console_platform_authz::Principal;
use uuid::Uuid;

use crate::HrApiError;

pub const ROSTER_FIELDS_PATH: &str = "/api/v1/roster-fields";
pub const ROSTER_FIELD_PATH_TEMPLATE: &str = "/api/v1/roster-fields/{id}";
pub const ROSTER_FIELD_ROUTE_PATHS: &[&str] = &[ROSTER_FIELDS_PATH, ROSTER_FIELD_PATH_TEMPLATE];

pub fn router(service: HrService) -> Router {
    Router::new()
        .route(ROSTER_FIELDS_PATH, get(list).post(create))
        .route(ROSTER_FIELD_PATH_TEMPLATE, patch(update))
        .with_state(service)
}

async fn list(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<RosterFieldList>, HrApiError> {
    Ok(Json(service.roster_fields(principal).await?))
}

async fn create(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<CreateRosterFieldRequest>,
) -> Result<(StatusCode, Json<RosterFieldView>), HrApiError> {
    Ok((
        StatusCode::CREATED,
        Json(service.create_roster_field(principal, request).await?),
    ))
}

async fn update(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
    Json(request): Json<UpdateRosterFieldRequest>,
) -> Result<Json<RosterFieldView>, HrApiError> {
    Ok(Json(
        service.update_roster_field(principal, id, request).await?,
    ))
}
