//! MR-27 bulk correction routes. Lane LIFE. INTEG mounts [`router`] inside
//! the authenticated HR router and registers [`BULK_CORRECTION_ROUTE_PATHS`].
//! The second-person facts come from the same place as the single PATCH's.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::bulk_corrections::{
    BulkCorrectionJob, BulkCorrectionPreview, BulkCorrectionRequest, IDEMPOTENCY_KEY_HEADER,
};
use console_platform_auth::PasskeyService;
use console_platform_authz::Principal;
use serde_json::Value;
use uuid::Uuid;

use crate::HrApiError;
use crate::corrections::holders::second_person_context;
use console_settings_domain::SettingKey;

pub const BULK_CORRECTION_PATH: &str = "/api/v1/employees/corrections/bulk";
pub const BULK_CORRECTION_PREVIEW_PATH: &str = "/api/v1/employees/corrections/bulk/preview";
pub const BULK_CORRECTION_JOB_PATH_TEMPLATE: &str = "/api/v1/employees/corrections/bulk/{id}";
pub const BULK_CORRECTION_ROUTE_PATHS: &[&str] = &[
    BULK_CORRECTION_PATH,
    BULK_CORRECTION_PREVIEW_PATH,
    BULK_CORRECTION_JOB_PATH_TEMPLATE,
];

#[derive(Clone)]
struct BulkCorrectionState {
    hr: HrService,
    passkeys: PasskeyService,
}

pub fn router(hr: HrService, passkeys: PasskeyService) -> Router {
    Router::new()
        .route(BULK_CORRECTION_PATH, post(commit))
        .route(BULK_CORRECTION_PREVIEW_PATH, post(preview))
        .route(BULK_CORRECTION_JOB_PATH_TEMPLATE, get(job))
        .with_state(BulkCorrectionState { hr, passkeys })
}

async fn preview(
    State(state): State<BulkCorrectionState>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<BulkCorrectionRequest>,
) -> Result<Json<BulkCorrectionPreview>, HrApiError> {
    let holders = second_person_context(
        &state.hr,
        &principal,
        Some(SettingKey::ApprovalPolicyPeopleCorrection),
    )
    .await?;
    Ok(Json(
        state
            .hr
            .preview_bulk_correction(principal, body, holders)
            .await?,
    ))
}

async fn commit(
    State(state): State<BulkCorrectionState>,
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    Json(body): Json<BulkCorrectionRequest>,
) -> Result<(StatusCode, Json<Value>), HrApiError> {
    let key = headers
        .get(IDEMPOTENCY_KEY_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let holders = second_person_context(
        &state.hr,
        &principal,
        Some(SettingKey::ApprovalPolicyPeopleCorrection),
    )
    .await?;
    let result = state
        .hr
        .commit_bulk_correction(principal, &state.passkeys, key, body, holders)
        .await?;
    // 202 when a field waits for a second person, as the single PATCH answers.
    let pending = result["counts"]["pending"].as_u64().unwrap_or(0) > 0;
    let status = if pending {
        StatusCode::ACCEPTED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(result)))
}

async fn job(
    State(state): State<BulkCorrectionState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
) -> Result<Json<BulkCorrectionJob>, HrApiError> {
    Ok(Json(state.hr.bulk_correction_job(principal, id).await?))
}
