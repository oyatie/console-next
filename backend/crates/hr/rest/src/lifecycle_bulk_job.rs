//! CAP-04 (decisions #27, #28): the bulk 발령 as a job. `POST
//! /employees/lifecycle-events/bulk` with `Prefer: respond-async` answers
//! 202 with the job and its `Location` once the request's own checks pass;
//! `GET …/bulk/jobs/{job_id}` reads it. Without the header the request stays
//! synchronous (200, as before).

use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Json, Router};
use console_hr_adapter_postgres::authz::authorize_hr_org_wide;
use console_hr_adapter_postgres::lifecycle::bulk_job::{
    BulkLifecycleJob, DriverSlot, RETRY_AFTER_SECS,
};
use console_hr_adapter_postgres::lifecycle::requests::BulkEmployeeLifecycleEventRequest;
use console_hr_adapter_postgres::{HrError, HrService};
use console_platform_authz::{Feature, Principal};
use console_platform_db::idempotency::{IDEMPOTENCY_KEY_HEADER, validate_idempotency_key};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::HrApiError;

pub const BULK_JOB_PATH_TEMPLATE: &str = "/api/v1/employees/lifecycle-events/bulk/jobs/{job_id}";
pub const LIFECYCLE_BULK_JOB_ROUTE_PATHS: &[&str] = &[BULK_JOB_PATH_TEMPLATE];

pub fn router(service: HrService) -> Router {
    Router::new()
        .route(BULK_JOB_PATH_TEMPLATE, get(job))
        .with_state(service)
}

async fn job(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(job_id): Path<Uuid>,
) -> Result<Json<BulkLifecycleJob>, HrApiError> {
    authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
    Ok(Json(service.bulk_lifecycle_job(&principal, job_id).await?))
}

/// Whether the request asked for an asynchronous answer (RFC 7240).
#[must_use]
pub fn prefers_async(headers: &HeaderMap) -> bool {
    headers
        .get_all("prefer")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|token| token.trim().eq_ignore_ascii_case("respond-async"))
}

/// `POST /employees/lifecycle-events/bulk` (the route is `app/src/hr.rs`'s):
/// the manage gate and the Idempotency-Key first, then the job or the
/// synchronous batch.
pub async fn create(
    service: &HrService,
    principal: Principal,
    headers: &HeaderMap,
    body: BulkEmployeeLifecycleEventRequest,
) -> Response {
    let checked =
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage).and_then(|()| {
            validate_idempotency_key(
                headers
                    .get(IDEMPOTENCY_KEY_HEADER)
                    .and_then(|v| v.to_str().ok()),
            )
            .map_err(HrError::validation)
        });
    let idempotency_key = match checked {
        Ok(key) => key,
        Err(error) => return HrApiError(error).into_response(),
    };
    if prefers_async(headers) {
        return accept(service, principal, idempotency_key, json!(&body)).await;
    }
    match service
        .bulk_lifecycle_events(principal, idempotency_key, body)
        .await
    {
        Ok(response) => Json(response).into_response(),
        Err(error) => HrApiError(error).into_response(),
    }
}

/// Accepts the batch as a job and starts its driver. A full process answers
/// 503 `bulk_lifecycle_busy` + `Retry-After` before anything is written.
async fn accept(
    service: &HrService,
    principal: Principal,
    idempotency_key: String,
    body: Value,
) -> Response {
    let slot = match DriverSlot::take() {
        Ok(slot) => slot,
        Err(error) => {
            let mut response = HrApiError(error).into_response();
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from(RETRY_AFTER_SECS));
            return response;
        }
    };
    let (job, start) = match service
        .accept_bulk_lifecycle_job(&principal, idempotency_key, body)
        .await
    {
        Ok(accepted) => accepted,
        Err(error) => return HrApiError(error).into_response(),
    };
    if start {
        service
            .clone()
            .spawn_bulk_lifecycle_job(principal, job.id, slot);
    }
    let location = BULK_JOB_PATH_TEMPLATE.replace("{job_id}", &job.id.to_string());
    let mut response = (StatusCode::ACCEPTED, Json(job)).into_response();
    if let Ok(location) = HeaderValue::from_str(&location) {
        response.headers_mut().insert(header::LOCATION, location);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn respond_async_is_read_from_any_prefer_token() {
        let mut headers = HeaderMap::new();
        assert!(!prefers_async(&headers));
        headers.insert(
            "prefer",
            HeaderValue::from_static("return=minimal, Respond-Async"),
        );
        assert!(prefers_async(&headers));
        headers.insert("prefer", HeaderValue::from_static("respond-asynchronously"));
        assert!(!prefers_async(&headers));
    }
}
