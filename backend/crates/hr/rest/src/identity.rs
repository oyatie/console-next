//! IMPORT-2 identity routes (decisions #25): an employee's 주민등록번호
//! (masked read; full reveal with a 사유 code, both in 접속기록), 사번 변경
//! with history and alias lookup, the tenant's numbering rules, and bulk
//! renumbering (preview → apply → SETUP undo). INTEG mounts [`router`] inside
//! the authenticated HR router with the shell's vault and registers
//! [`IDENTITY_ROUTE_PATHS`].

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use console_hr_adapter_postgres::employee_number::change::{
    EmployeeNumberChange, EmployeeNumberChangeRequest, EmployeeNumberMatch,
};
use console_hr_adapter_postgres::employee_number::renumber::{RenumberPreview, RenumberRequest};
use console_hr_adapter_postgres::employee_number::renumber_apply::{
    RenumberApplyRequest, RenumberResult,
};
use console_hr_adapter_postgres::employee_number::rules::{NumberRuleRequest, NumberRuleView};
use console_hr_adapter_postgres::rrn::{RrnRevealRequest, RrnRevealed, RrnStatus};
use console_hr_adapter_postgres::{HrError, HrService};
use console_hr_domain::import::rrn_value::RrnVault;
use console_platform_authz::Principal;
use serde::Deserialize;
use uuid::Uuid;

use crate::HrApiError;

pub const RRN_PATH: &str = "/api/v1/employees/{id}/rrn";
pub const RRN_REVEAL_PATH: &str = "/api/v1/employees/{id}/rrn/reveal";
pub const EMPLOYEE_NUMBER_PATH: &str = "/api/v1/employees/{id}/employee-number";
pub const EMPLOYEE_NUMBER_HISTORY_PATH: &str = "/api/v1/employees/{id}/employee-number/history";
pub const EMPLOYEE_BY_NUMBER_PATH: &str = "/api/v1/employees/by-number/{number}";
pub const NUMBER_RULES_PATH: &str = "/api/v1/employee-number-rules";
pub const RENUMBER_PREVIEW_PATH: &str = "/api/v1/employees/renumber/preview";
pub const RENUMBER_APPLY_PATH: &str = "/api/v1/employees/renumber/apply";
pub const RENUMBER_UNDO_PATH: &str = "/api/v1/employees/renumber/{batch_id}/undo";
pub const IDENTITY_ROUTE_PATHS: &[&str] = &[
    RRN_PATH,
    RRN_REVEAL_PATH,
    EMPLOYEE_NUMBER_PATH,
    EMPLOYEE_NUMBER_HISTORY_PATH,
    EMPLOYEE_BY_NUMBER_PATH,
    NUMBER_RULES_PATH,
    RENUMBER_PREVIEW_PATH,
    RENUMBER_APPLY_PATH,
    RENUMBER_UNDO_PATH,
];

#[derive(Clone)]
struct IdentityState {
    hr: HrService,
    vault: Option<Arc<dyn RrnVault>>,
}

pub fn router(hr: HrService, vault: Option<Arc<dyn RrnVault>>) -> Router {
    Router::new()
        .route(RRN_PATH, get(rrn_status))
        .route(RRN_REVEAL_PATH, post(rrn_reveal))
        .route(EMPLOYEE_NUMBER_PATH, post(change_number))
        .route(EMPLOYEE_NUMBER_HISTORY_PATH, get(number_history))
        .route(EMPLOYEE_BY_NUMBER_PATH, get(by_number))
        .route(
            NUMBER_RULES_PATH,
            get(rules).put(set_rule).delete(remove_rule),
        )
        .route(RENUMBER_PREVIEW_PATH, post(renumber_preview))
        .route(RENUMBER_APPLY_PATH, post(renumber_apply))
        .route(RENUMBER_UNDO_PATH, post(renumber_undo))
        .with_state(IdentityState { hr, vault })
}

type Reply<T> = Result<Json<T>, HrApiError>;

async fn rrn_status(
    State(s): State<IdentityState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
) -> Reply<RrnStatus> {
    Ok(Json(s.hr.rrn_status(principal, id).await?))
}

async fn rrn_reveal(
    State(s): State<IdentityState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
    Json(body): Json<RrnRevealRequest>,
) -> Reply<RrnRevealed> {
    let vault = s.vault.as_deref();
    Ok(Json(s.hr.rrn_reveal(principal, id, body, vault).await?))
}

async fn change_number(
    State(s): State<IdentityState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
    Json(body): Json<EmployeeNumberChangeRequest>,
) -> Reply<EmployeeNumberChange> {
    Ok(Json(
        s.hr.change_employee_number(principal, id, body).await?,
    ))
}

async fn number_history(
    State(s): State<IdentityState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
) -> Reply<Vec<EmployeeNumberChange>> {
    Ok(Json(s.hr.employee_number_history(principal, id).await?))
}

async fn by_number(
    State(s): State<IdentityState>,
    Extension(principal): Extension<Principal>,
    Path(number): Path<String>,
) -> Reply<EmployeeNumberMatch> {
    s.hr.find_by_employee_number(principal, number)
        .await?
        .map(Json)
        .ok_or_else(|| {
            HrApiError(HrError {
                status: StatusCode::NOT_FOUND,
                code: "not_found",
                message: "no employee has or had that 사번".to_owned(),
                refusals: None,
            })
        })
}

async fn rules(
    State(s): State<IdentityState>,
    Extension(principal): Extension<Principal>,
) -> Reply<Vec<NumberRuleView>> {
    Ok(Json(s.hr.employee_number_rules(principal).await?))
}

async fn set_rule(
    State(s): State<IdentityState>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<NumberRuleRequest>,
) -> Reply<NumberRuleView> {
    Ok(Json(s.hr.set_employee_number_rule(principal, body).await?))
}

#[derive(Debug, Deserialize)]
struct RuleScope {
    scope_kind: String,
    #[serde(default)]
    scope_id: Option<Uuid>,
}

async fn remove_rule(
    State(s): State<IdentityState>,
    Extension(principal): Extension<Principal>,
    Query(scope): Query<RuleScope>,
) -> Result<StatusCode, HrApiError> {
    s.hr.remove_employee_number_rule(principal, scope.scope_kind, scope.scope_id)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn renumber_preview(
    State(s): State<IdentityState>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<RenumberRequest>,
) -> Reply<RenumberPreview> {
    Ok(Json(s.hr.preview_renumber(principal, body).await?))
}

async fn renumber_apply(
    State(s): State<IdentityState>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<RenumberApplyRequest>,
) -> Reply<RenumberResult> {
    Ok(Json(s.hr.apply_renumber(principal, body).await?))
}

async fn renumber_undo(
    State(s): State<IdentityState>,
    Extension(principal): Extension<Principal>,
    Path(batch): Path<Uuid>,
) -> Reply<RenumberResult> {
    Ok(Json(s.hr.undo_renumber(principal, batch).await?))
}
