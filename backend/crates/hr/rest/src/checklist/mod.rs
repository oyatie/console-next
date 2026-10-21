//! E10 onboarding checklist route (read only, derived).

use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Extension, Json, Router};
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::checklist::OnboardingChecklist;
use console_platform_authz::Principal;
use uuid::Uuid;

use crate::HrApiError;

pub const ONBOARDING_CHECKLIST_PATH_TEMPLATE: &str = "/api/v1/employees/{id}/onboarding-checklist";
pub const CHECKLIST_ROUTE_PATHS: &[&str] = &[ONBOARDING_CHECKLIST_PATH_TEMPLATE];

pub fn router(service: HrService) -> Router {
    Router::new()
        .route(ONBOARDING_CHECKLIST_PATH_TEMPLATE, get(get_checklist))
        .with_state(service)
}

async fn get_checklist(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(employee_id): Path<Uuid>,
) -> Result<Json<OnboardingChecklist>, HrApiError> {
    Ok(Json(
        service.onboarding_checklist(principal, employee_id).await?,
    ))
}
