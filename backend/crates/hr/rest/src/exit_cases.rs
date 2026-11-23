// SPDX-License-Identifier: LicenseRef-Proprietary
//! Bulk exit-case command and status counts routes.

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::exits::bulk_report::BulkReportExitCasesRequest;
use console_hr_adapter_postgres::exits::counts::{ExitCaseCountsQuery, ExitCaseCountsResponse};
use console_platform_authz::Principal;
use console_platform_db::idempotency::{IDEMPOTENCY_KEY_HEADER, validate_idempotency_key};
use serde_json::Value;

use crate::HrApiError;

pub const HR_EXIT_CASES_BULK_PATH: &str = "/api/v1/hr/exit-cases/bulk";
pub const HR_EXIT_CASES_COUNTS_PATH: &str = "/api/v1/hr/exit-cases/counts";
pub const EXIT_CASES_ROUTE_PATHS: &[&str] = &[HR_EXIT_CASES_BULK_PATH, HR_EXIT_CASES_COUNTS_PATH];

pub fn router(hr: HrService) -> Router {
    Router::new()
        .route(HR_EXIT_CASES_BULK_PATH, post(bulk_report))
        .route(HR_EXIT_CASES_COUNTS_PATH, get(counts))
        .with_state(hr)
}

async fn bulk_report(
    State(hr): State<HrService>,
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    Json(body): Json<BulkReportExitCasesRequest>,
) -> Result<(StatusCode, Json<Value>), HrApiError> {
    let raw_key = headers
        .get(IDEMPOTENCY_KEY_HEADER)
        .and_then(|v| v.to_str().ok());
    let idempotency_key = validate_idempotency_key(raw_key)
        .map_err(console_hr_adapter_postgres::HrError::validation)?;
    let (status, payload) = hr
        .bulk_report_exit_cases(principal, idempotency_key, body)
        .await?;
    Ok((status, Json(payload)))
}

async fn counts(
    State(hr): State<HrService>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<ExitCaseCountsQuery>,
) -> Result<Json<ExitCaseCountsResponse>, HrApiError> {
    Ok(Json(hr.exit_case_counts(principal, query).await?))
}
