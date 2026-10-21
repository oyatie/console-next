//! BW-18 correction routes. Lane PEOPLE-A. INTEG mounts [`router`] inside the
//! authenticated HR router (the `Principal` extension comes from there) and
//! registers [`CORRECTIONS_ROUTE_PATHS`]. The `PasskeyService` verifies the
//! IDENTITY_MERGE step-up and a sole holder's correction step-up inside the
//! write transaction.

pub(crate) mod holders;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, patch, post};
use axum::{Extension, Json, Router};
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::corrections::identity::{
    IdentityResolutionOutcome, ResolveIdentityRequest,
};
use console_hr_adapter_postgres::corrections::{CorrectEmployeeRequest, CorrectionOutcome};
use console_hr_adapter_postgres::registration_void::ends::EmployeeEndOptions;
use console_hr_adapter_postgres::registration_void::list::VoidedEmployee;
use console_hr_adapter_postgres::registration_void::{
    SetupDeleteRequest, VoidEmployeeRequest, VoidOutcome,
};
use console_platform_auth::PasskeyService;
use console_platform_authz::Principal;
use console_settings_domain::SettingKey;
use uuid::Uuid;

use crate::HrApiError;

pub const EMPLOYEE_CORRECTION_PATH: &str = "/api/v1/employees/{id}";
pub const IDENTITY_RESOLUTION_PATH: &str = "/api/v1/employees/{id}/identity-resolution";
/// MR-26: 등록 취소 after 운영 시작 (`DELETE` on [`EMPLOYEE_CORRECTION_PATH`]
/// is the SETUP delete).
pub const EMPLOYEE_VOID_PATH: &str = "/api/v1/employees/{id}/void";
/// MR-26: the 「취소된 등록」 list.
pub const EMPLOYEE_VOIDS_PATH: &str = "/api/v1/employees/voided";
// --- lane: CRUD ---
/// 등록 취소 or 퇴직: which way the record ends, and why not the other.
pub const EMPLOYEE_END_OPTIONS_PATH: &str = "/api/v1/employees/{id}/end-options";
pub const CORRECTIONS_ROUTE_PATHS: &[&str] = &[
    EMPLOYEE_CORRECTION_PATH,
    IDENTITY_RESOLUTION_PATH,
    EMPLOYEE_VOID_PATH,
    EMPLOYEE_VOIDS_PATH,
    EMPLOYEE_END_OPTIONS_PATH,
];

#[derive(Clone)]
struct CorrectionsState {
    hr: HrService,
    passkeys: PasskeyService,
}

/// The routes that may need a step-up. `PATCH` only on `/employees/{id}`:
/// INTEG merges it with the directory's `GET` (and [`setup_router`]'s
/// `DELETE`) on the same path.
pub fn router(hr: HrService, passkeys: PasskeyService) -> Router {
    Router::new()
        .route(EMPLOYEE_CORRECTION_PATH, patch(correct))
        .route(IDENTITY_RESOLUTION_PATH, post(resolve_identity))
        .route(EMPLOYEE_VOID_PATH, post(void))
        .with_state(CorrectionsState { hr, passkeys })
}

/// MR-26 routes that never take a step-up (the SETUP delete, the voided
/// list), so they are mounted even without WebAuthn: the first-run SETUP
/// undo must exist in every deployment.
pub fn setup_router(hr: HrService) -> Router {
    Router::new()
        .route(EMPLOYEE_CORRECTION_PATH, delete(setup_delete))
        .route(EMPLOYEE_VOIDS_PATH, get(list_voided))
        .route(EMPLOYEE_END_OPTIONS_PATH, get(end_options))
        .with_state(hr)
}

/// 200 when everything applied; 202 when a field waits for a second person.
fn status(pending: bool) -> StatusCode {
    if pending {
        StatusCode::ACCEPTED
    } else {
        StatusCode::OK
    }
}

async fn correct(
    State(state): State<CorrectionsState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
    Json(body): Json<CorrectEmployeeRequest>,
) -> Result<(StatusCode, Json<CorrectionOutcome>), HrApiError> {
    let holders = holders::second_person_context(
        &state.hr,
        &principal,
        Some(SettingKey::ApprovalPolicyPeopleCorrection),
    )
    .await?;
    let outcome = state
        .hr
        .correct_employee(principal, &state.passkeys, id, body, holders)
        .await?;
    Ok((status(outcome.pending_request.is_some()), Json(outcome)))
}

async fn resolve_identity(
    State(state): State<CorrectionsState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
    Json(body): Json<ResolveIdentityRequest>,
) -> Result<(StatusCode, Json<IdentityResolutionOutcome>), HrApiError> {
    let holders = holders::second_person_context(
        &state.hr,
        &principal,
        Some(SettingKey::ApprovalPolicyIdentityMerge),
    )
    .await?;
    let outcome = state
        .hr
        .resolve_identity(principal, &state.passkeys, id, body, holders)
        .await?;
    Ok((status(outcome.pending_request.is_some()), Json(outcome)))
}

async fn end_options(
    State(hr): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
) -> Result<Json<EmployeeEndOptions>, HrApiError> {
    Ok(Json(hr.employee_end_options(&principal, id).await?))
}

async fn setup_delete(
    State(hr): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
    Json(body): Json<SetupDeleteRequest>,
) -> Result<Json<VoidOutcome>, HrApiError> {
    Ok(Json(hr.setup_delete_employee(principal, id, body).await?))
}

async fn void(
    State(state): State<CorrectionsState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
    Json(body): Json<VoidEmployeeRequest>,
) -> Result<(StatusCode, Json<VoidOutcome>), HrApiError> {
    let holders = holders::second_person_context(
        &state.hr,
        &principal,
        Some(SettingKey::ApprovalPolicyRegistrationVoid),
    )
    .await?;
    let outcome = state
        .hr
        .void_employee(principal, &state.passkeys, id, body, holders)
        .await?;
    Ok((status(outcome.pending_request.is_some()), Json(outcome)))
}

async fn list_voided(
    State(hr): State<HrService>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<Vec<VoidedEmployee>>, HrApiError> {
    Ok(Json(hr.list_voided(principal).await?))
}
