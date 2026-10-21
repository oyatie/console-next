//! BW-12 fixed-term service read (기간제법 §4①).

use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Extension, Json, Router};
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::lifecycle::fixed_term::FixedTermView;
use console_platform_authz::Principal;
use uuid::Uuid;

use crate::HrApiError;

pub const FIXED_TERM_PATH_TEMPLATE: &str = "/api/v1/employees/{id}/fixed-term";
pub const FIXED_TERM_ROUTE_PATHS: &[&str] = &[FIXED_TERM_PATH_TEMPLATE];

pub fn router(service: HrService) -> Router {
    Router::new()
        .route(FIXED_TERM_PATH_TEMPLATE, get(read))
        .with_state(service)
}

async fn read(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(employee_id): Path<Uuid>,
) -> Result<Json<FixedTermView>, HrApiError> {
    Ok(Json(
        service.employee_fixed_term(principal, employee_id).await?,
    ))
}
