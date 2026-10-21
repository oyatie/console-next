//! BW-13 / MR-25 classification catalog routes (`?kind=` filters the list). A repeated add of the same label answers
//! 200 with the existing row, a new one 201.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, patch};
use axum::{Extension, Json, Router};
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::job_title::{
    CreateJobTitleRequest, JobTitleList, JobTitleListQuery, JobTitleView, UpdateJobTitleRequest,
};
use console_platform_authz::Principal;
use uuid::Uuid;

use crate::HrApiError;

pub const JOB_TITLES_PATH: &str = "/api/v1/job-titles";
pub const JOB_TITLE_PATH_TEMPLATE: &str = "/api/v1/job-titles/{id}";
pub const JOB_TITLE_ROUTE_PATHS: &[&str] = &[JOB_TITLES_PATH, JOB_TITLE_PATH_TEMPLATE];

pub fn router(service: HrService) -> Router {
    Router::new()
        .route(JOB_TITLES_PATH, get(list).post(create))
        .route(JOB_TITLE_PATH_TEMPLATE, patch(update))
        .with_state(service)
}

async fn list(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<JobTitleListQuery>,
) -> Result<Json<JobTitleList>, HrApiError> {
    Ok(Json(service.job_titles(principal, query).await?))
}

async fn create(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<CreateJobTitleRequest>,
) -> Result<(StatusCode, Json<JobTitleView>), HrApiError> {
    let (view, created) = service.create_job_title(principal, request).await?;
    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(view)))
}

async fn update(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
    Json(request): Json<UpdateJobTitleRequest>,
) -> Result<Json<JobTitleView>, HrApiError> {
    Ok(Json(
        service.update_job_title(principal, id, request).await?,
    ))
}
