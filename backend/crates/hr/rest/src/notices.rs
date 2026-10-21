//! 발령 공고 routes (BE-EMP-UI, EMP-UI 10). Issue needs the Idempotency-Key
//! header; the gates are in the service.

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::get;
use axum::{Extension, Json, Router};
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::change_sets::IDEMPOTENCY_KEY_HEADER;
use console_hr_adapter_postgres::notices::{
    AppointmentNotice, AppointmentNoticeListQuery, AppointmentNoticePage,
    IssueAppointmentNoticeRequest,
};
use console_platform_authz::Principal;
use serde_json::Value;
use uuid::Uuid;

use crate::HrApiError;

pub const APPOINTMENT_NOTICES_PATH: &str = "/api/v1/appointment-notices";
pub const APPOINTMENT_NOTICE_PATH_TEMPLATE: &str = "/api/v1/appointment-notices/{id}";
pub const APPOINTMENT_NOTICE_ROUTE_PATHS: &[&str] =
    &[APPOINTMENT_NOTICES_PATH, APPOINTMENT_NOTICE_PATH_TEMPLATE];

pub fn router(service: HrService) -> Router {
    Router::new()
        .route(APPOINTMENT_NOTICES_PATH, get(list).post(issue))
        .route(APPOINTMENT_NOTICE_PATH_TEMPLATE, get(read))
        .with_state(service)
}

async fn issue(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    Json(body): Json<IssueAppointmentNoticeRequest>,
) -> Result<(StatusCode, Json<Value>), HrApiError> {
    let key = headers
        .get(IDEMPOTENCY_KEY_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let notice = service
        .issue_appointment_notice(principal, key, body)
        .await?;
    Ok((StatusCode::CREATED, Json(notice)))
}

async fn list(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<AppointmentNoticeListQuery>,
) -> Result<Json<AppointmentNoticePage>, HrApiError> {
    Ok(Json(service.appointment_notices(principal, query).await?))
}

async fn read(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
) -> Result<Json<AppointmentNotice>, HrApiError> {
    Ok(Json(service.appointment_notice(principal, id).await?))
}
