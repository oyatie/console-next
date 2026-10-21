//! EMP-CREATE registration aids (pre-alpha gate U8). INTEG registers
//! `REGISTRATION_ROUTE_PATHS` in `CONFIGURED_ROUTE_SURFACES` and merges
//! `router`.

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Extension, Json, Router};
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::profile::{MinimumWageHint, MinimumWageQuery};
use console_platform_authz::Principal;

use crate::HrApiError;

pub const MINIMUM_WAGE_PATH: &str = "/api/v1/hr/minimum-wage";
pub const REGISTRATION_ROUTE_PATHS: &[&str] = &[MINIMUM_WAGE_PATH];

pub fn router(service: HrService) -> Router {
    Router::new()
        .route(MINIMUM_WAGE_PATH, get(minimum_wage))
        .with_state(service)
}

/// The 최저임금 floor for a pay unit on a day; `null` when the register has
/// no figure for that day.
async fn minimum_wage(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<MinimumWageQuery>,
) -> Result<Json<Option<MinimumWageHint>>, HrApiError> {
    Ok(Json(service.minimum_wage(&principal, query)?))
}
