//! 근로자 명부 item routes (MR-23, lane EMP-FACTS). INTEG mounts [`router`]
//! inside the authenticated HR router and registers
//! [`REGISTER_FACTS_ROUTE_PATHS`]. One-by-one changes of these items are
//! corrections: `PATCH /employees/{id}` (the corrections router).

use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::register_facts::bulk::{
    BulkRegisterFactsOutcome, BulkRegisterFactsRequest,
};
use console_hr_adapter_postgres::register_facts::read::RegisterFactsResponse;
use console_platform_authz::Principal;
use uuid::Uuid;

use crate::HrApiError;

pub const REGISTER_FACTS_PATH: &str = "/api/v1/employees/{id}/register-facts";
pub const REGISTER_FACTS_BULK_PATH: &str = "/api/v1/employees/register-facts/bulk";
pub const REGISTER_FACTS_ROUTE_PATHS: &[&str] = &[REGISTER_FACTS_PATH, REGISTER_FACTS_BULK_PATH];

pub fn router(hr: HrService) -> Router {
    Router::new()
        .route(REGISTER_FACTS_PATH, get(read))
        .route(REGISTER_FACTS_BULK_PATH, post(bulk))
        .with_state(hr)
}

async fn read(
    State(hr): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
) -> Result<Json<RegisterFactsResponse>, HrApiError> {
    Ok(Json(hr.register_facts(principal, id).await?))
}

async fn bulk(
    State(hr): State<HrService>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<BulkRegisterFactsRequest>,
) -> Result<Json<BulkRegisterFactsOutcome>, HrApiError> {
    Ok(Json(hr.bulk_correct_register_facts(principal, body).await?))
}
