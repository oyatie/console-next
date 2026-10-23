// SPDX-License-Identifier: LicenseRef-Proprietary
//! Employee import history, behind the import's org-wide management gate.

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use console_hr_adapter_postgres::authz::authorize_hr_org_wide;
use console_hr_adapter_postgres::import::rollback::{
    RollbackCredentials, RollbackOutcome, RollbackPreview, RollbackRequest,
};
use console_hr_adapter_postgres::import::run_record::{
    EmployeeImportRun, EmployeeImportRunPage, RunListQuery,
};
use console_hr_adapter_postgres::{HrError, HrService};
use console_platform_auth::PasskeyService;
use console_platform_authz::{Feature, Principal};
use console_platform_db::idempotency::{IDEMPOTENCY_KEY_HEADER, validate_idempotency_key};
use console_settings_domain::SettingKey;
use uuid::Uuid;

use crate::HrApiError;

pub const IMPORT_RUNS_PATH: &str = "/api/v1/employee-import-runs";
pub const IMPORT_RUN_PATH: &str = "/api/v1/employee-import-runs/{run_id}";
pub const IMPORT_ROLLBACK_PREVIEW_PATH: &str =
    "/api/v1/employee-import-runs/{run_id}/rollback/preview";
pub const IMPORT_ROLLBACK_PATH: &str = "/api/v1/employee-import-runs/{run_id}/rollback";
pub const IMPORT_RUN_ROUTE_PATHS: &[&str] = &[
    IMPORT_RUNS_PATH,
    IMPORT_RUN_PATH,
    IMPORT_ROLLBACK_PREVIEW_PATH,
    IMPORT_ROLLBACK_PATH,
];

#[derive(Clone)]
struct ImportRunsState {
    hr: HrService,
    passkeys: Option<PasskeyService>,
}

pub fn router(hr: HrService, passkeys: Option<PasskeyService>) -> Router {
    Router::new()
        .route(IMPORT_RUNS_PATH, get(list))
        .route(IMPORT_RUN_PATH, get(record))
        .route(IMPORT_ROLLBACK_PREVIEW_PATH, post(preview))
        .route(IMPORT_ROLLBACK_PATH, post(rollback))
        .with_state(ImportRunsState { hr, passkeys })
}

async fn list(
    State(state): State<ImportRunsState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<RunListQuery>,
) -> Result<Json<EmployeeImportRunPage>, HrApiError> {
    Ok(Json(state.hr.import_runs(principal, query).await?))
}

async fn record(
    State(state): State<ImportRunsState>,
    Extension(principal): Extension<Principal>,
    Path(run_id): Path<Uuid>,
) -> Result<Json<EmployeeImportRun>, HrApiError> {
    Ok(Json(state.hr.import_run(principal, run_id).await?))
}

async fn preview(
    State(state): State<ImportRunsState>,
    Extension(principal): Extension<Principal>,
    Path(run_id): Path<Uuid>,
) -> Result<Json<RollbackPreview>, HrApiError> {
    let mut plan = state
        .hr
        .preview_import_rollback(principal.clone(), run_id)
        .await?;
    if plan.basis == console_hr_domain::import::rollback::Basis::SecondPerson {
        let holders = crate::corrections::holders::second_person_context(
            &state.hr,
            &principal,
            Some(SettingKey::ApprovalPolicyImportRollback),
        )
        .await?;
        if holders.other_eligible_holders == 0 {
            if holders.sole_holder_refuse {
                return Err(HrError {
                    status: StatusCode::FORBIDDEN,
                    code: "import_rollback_sole_holder_refused",
                    message: "another eligible holder is required".into(),
                    errors: None,
                    refusals: None,
                }
                .into());
            } else {
                plan.basis = console_hr_domain::import::rollback::Basis::StepUp;
            }
        }
    }
    Ok(Json(plan))
}

async fn rollback(
    State(state): State<ImportRunsState>,
    Extension(principal): Extension<Principal>,
    Path(run_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<RollbackRequest>,
) -> Result<(StatusCode, Json<RollbackOutcome>), HrApiError> {
    authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
    let idempotency_key = validate_idempotency_key(
        headers
            .get(IDEMPOTENCY_KEY_HEADER)
            .and_then(|value| value.to_str().ok()),
    )
    .map_err(HrError::validation)?;
    let holders = crate::corrections::holders::second_person_context(
        &state.hr,
        &principal,
        Some(SettingKey::ApprovalPolicyImportRollback),
    )
    .await?;
    let asynchronous = crate::lifecycle_bulk_job::prefers_async(&headers);
    let slot = console_hr_adapter_postgres::import::apply_job::DriverSlot::take()?;
    let org = principal.org_id;
    let credentials = Some(RollbackCredentials {
        passkeys: state.passkeys,
        idempotency_key,
    });
    let outcome = if asynchronous {
        state
            .hr
            .start_import_rollback(principal, run_id, body, credentials, holders)
            .await?
    } else {
        state
            .hr
            .rollback_import(principal, run_id, body, credentials, holders)
            .await?
    };
    if outcome.status == "ROLLBACK_RUNNING" {
        state.hr.spawn_import_rollback(org, run_id, slot);
    }
    let status = if outcome.status != "ROLLED_BACK" {
        StatusCode::ACCEPTED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(outcome)))
}
