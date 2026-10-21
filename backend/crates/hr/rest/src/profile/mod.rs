//! EMP-MODEL facts routes (parity E3, E4, E5, E12/F5, E13). INTEG registers
//! `PROFILE_ROUTE_PATHS` in `CONFIGURED_ROUTE_SURFACES` and merges `router`.

use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::profile::{ConfirmProbationRequest, EmploymentFacts};
use console_platform_authz::Principal;
use console_platform_preconditions::PatchOp;
use uuid::Uuid;

use crate::HrApiError;

pub const EMPLOYMENT_FACTS_PATH_TEMPLATE: &str = "/api/v1/employees/{id}/employment-facts";
pub const PROBATION_CONFIRM_PATH_TEMPLATE: &str = "/api/v1/employees/{id}/probation/confirm";
pub const PROFILE_ROUTE_PATHS: &[&str] = &[
    EMPLOYMENT_FACTS_PATH_TEMPLATE,
    PROBATION_CONFIRM_PATH_TEMPLATE,
];

pub fn router(service: HrService) -> Router {
    Router::new()
        .route(
            EMPLOYMENT_FACTS_PATH_TEMPLATE,
            get(get_employment_facts).patch(patch_employment_facts),
        )
        .route(PROBATION_CONFIRM_PATH_TEMPLATE, post(confirm_probation))
        .with_state(service)
}

async fn get_employment_facts(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(employee_id): Path<Uuid>,
) -> Result<Json<EmploymentFacts>, HrApiError> {
    Ok(Json(
        service.employment_facts(principal, employee_id).await?,
    ))
}

/// `application/json-patch+json` with a `test` per touched path (ME-6).
async fn patch_employment_facts(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(employee_id): Path<Uuid>,
    Json(ops): Json<Vec<PatchOp>>,
) -> Result<Json<EmploymentFacts>, HrApiError> {
    Ok(Json(
        service
            .patch_employment_facts(principal, employee_id, ops)
            .await?,
    ))
}

async fn confirm_probation(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(employee_id): Path<Uuid>,
    Json(request): Json<ConfirmProbationRequest>,
) -> Result<Json<EmploymentFacts>, HrApiError> {
    Ok(Json(
        service
            .confirm_probation(principal, employee_id, request)
            .await?,
    ))
}
