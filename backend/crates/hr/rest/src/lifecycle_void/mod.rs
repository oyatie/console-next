//! BW-11 정정 (correct) and 취소·철회 (rescind) routes. Without
//! `confirm_cascades: true` a rescind only previews its cascades.

use axum::extract::{Path, State};
use axum::routing::post;
use axum::{Extension, Json, Router};
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::lifecycle::correct::CorrectLifecycleEventRequest;
use console_hr_adapter_postgres::lifecycle::types::EmployeeLifecycleEventResponse;
use console_hr_adapter_postgres::lifecycle::void::{RescindLifecycleEventRequest, RescindOutcome};
use console_platform_authz::Principal;
use uuid::Uuid;

use crate::HrApiError;

pub const RESCIND_PATH_TEMPLATE: &str =
    "/api/v1/employees/{id}/lifecycle-events/{event_id}/rescind";
pub const CORRECT_PATH_TEMPLATE: &str =
    "/api/v1/employees/{id}/lifecycle-events/{event_id}/correct";
pub const BATCH_RESCIND_PATH_TEMPLATE: &str =
    "/api/v1/employees/lifecycle-events/bulk/{batch_id}/rescind";
pub const LIFECYCLE_VOID_ROUTE_PATHS: &[&str] = &[
    RESCIND_PATH_TEMPLATE,
    CORRECT_PATH_TEMPLATE,
    BATCH_RESCIND_PATH_TEMPLATE,
];

pub fn router(service: HrService) -> Router {
    Router::new()
        .route(RESCIND_PATH_TEMPLATE, post(rescind))
        .route(CORRECT_PATH_TEMPLATE, post(correct))
        .route(BATCH_RESCIND_PATH_TEMPLATE, post(rescind_batch))
        .with_state(service)
}

async fn rescind(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path((employee_id, event_id)): Path<(Uuid, Uuid)>,
    Json(request): Json<RescindLifecycleEventRequest>,
) -> Result<Json<RescindOutcome>, HrApiError> {
    Ok(Json(
        service
            .rescind_lifecycle_event(principal, employee_id, event_id, request)
            .await?,
    ))
}

async fn correct(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path((employee_id, event_id)): Path<(Uuid, Uuid)>,
    Json(request): Json<CorrectLifecycleEventRequest>,
) -> Result<Json<EmployeeLifecycleEventResponse>, HrApiError> {
    Ok(Json(
        service
            .correct_lifecycle_event(principal, employee_id, event_id, request)
            .await?,
    ))
}

async fn rescind_batch(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(batch_id): Path<Uuid>,
    Json(request): Json<RescindLifecycleEventRequest>,
) -> Result<Json<Vec<RescindOutcome>>, HrApiError> {
    Ok(Json(
        service
            .rescind_lifecycle_batch(principal, batch_id, request)
            .await?,
    ))
}
