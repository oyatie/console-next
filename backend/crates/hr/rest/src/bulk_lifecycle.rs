//! The bulk 발령 preview route (BE-EMP-UI, EMP-UI 8): the commit's
//! validation, read-only. Same gate as the bulk commit (in the service).

use axum::extract::State;
use axum::routing::post;
use axum::{Extension, Json, Router};
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::lifecycle::bulk_preview::BulkLifecyclePreview;
use console_hr_adapter_postgres::lifecycle::requests::BulkEmployeeLifecycleEventRequest;
use console_platform_authz::Principal;

use crate::HrApiError;

pub const BULK_LIFECYCLE_PREVIEW_PATH: &str = "/api/v1/employees/lifecycle-events/bulk/preview";
pub const BULK_LIFECYCLE_ROUTE_PATHS: &[&str] = &[BULK_LIFECYCLE_PREVIEW_PATH];

pub fn router(service: HrService) -> Router {
    Router::new()
        .route(BULK_LIFECYCLE_PREVIEW_PATH, post(preview))
        .with_state(service)
}

async fn preview(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<BulkEmployeeLifecycleEventRequest>,
) -> Result<Json<BulkLifecyclePreview>, HrApiError> {
    Ok(Json(
        service
            .preview_bulk_lifecycle_events(principal, body)
            .await?,
    ))
}
