//! The wire of a 사업장 close plan (`/api/v1/workplaces/{id}/close-plan`).

use console_entity_adapter_postgres::PgEntityError;
use console_entity_adapter_postgres::workplace_close_plan::{ClosePerson, CloseScope, ScopeUnit};
use console_kernel_core::ErrorKind;
use http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::HrError;
use crate::lifecycle::group_transfer::GroupTransferRequest;

/// What happens to one person on the 폐쇄일.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PersonAction {
    /// 전근 to a 부서 (or 사업장 unit) of another open 사업장 of the same 법인.
    Transfer,
    /// 퇴직: an exit case with 마지막 근무일 = the day before the 폐쇄일.
    Exit,
    /// 전적 to a 부서 at another 법인's open 사업장, with the person's consent
    /// and continuity: recorded when the plan is, effective on the 폐쇄일.
    GroupTransfer,
}

/// What happens to one 부서 directly under the 사업장 (its sub-부서 go with it).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum UnitAction {
    /// Moved under another open 사업장's unit or one of its 부서.
    Move,
    /// 폐지, once nobody is placed in it.
    Dissolve,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PersonLine {
    pub employee_id: Uuid,
    pub action: PersonAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_org_unit_id: Option<Uuid>,
    /// EXIT: a BW-07 `exit_reason` code (`CLOSURE` 폐업 by default, or `INSOLVENCY` 도산).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_reason_code: Option<String>,
    /// GROUP_TRANSFER: the receiving 사업장 (`to_org_unit_id` sits at it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_workplace_id: Option<Uuid>,
    /// GROUP_TRANSFER: the consent and continuity, as a single 전적 takes them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_transfer: Option<GroupTransferRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UnitLine {
    pub org_unit_id: Uuid,
    pub action: UnitAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_parent_id: Option<Uuid>,
}

/// `POST /api/v1/workplaces/{workplaceId}/close-plan`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkplaceClosePlanRequest {
    pub closed_on: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    #[serde(default)]
    pub people: Vec<PersonLine>,
    #[serde(default)]
    pub units: Vec<UnitLine>,
}

/// An open exit case of someone still at the 사업장 (company-52).
#[derive(Debug, Clone, Serialize)]
pub struct OpenExitCase {
    pub employee_id: Uuid,
    pub case_id: Uuid,
    pub status: String,
    pub effective_exit_date: String,
}

/// One job, with its lines.
#[derive(Debug, Clone, Serialize)]
pub struct CloseJob {
    pub id: Uuid,
    pub workplace_id: Uuid,
    pub closed_on: String,
    pub reason_code: Option<String>,
    pub state: String,
    pub failure: Option<Value>,
    pub created_at: String,
    pub settled_at: Option<String>,
    pub lines: Vec<JobLine>,
}

#[derive(Debug, Clone, Serialize)]
pub struct JobLine {
    pub employee_id: Option<Uuid>,
    pub org_unit_id: Option<Uuid>,
    pub action: String,
    pub target_unit_id: Option<Uuid>,
    pub target_workplace_id: Option<Uuid>,
    pub exit_reason_code: Option<String>,
    pub exit_case_id: Option<Uuid>,
    pub lifecycle_event_id: Option<Uuid>,
    pub done: bool,
}

/// `GET /api/v1/workplaces/{workplaceId}/close-plan`: everything the plan
/// sheet needs, and the open (or last) job.
#[derive(Debug, Clone, Serialize)]
pub struct WorkplaceClosePlanView {
    #[serde(flatten)]
    pub scope: CloseScope,
    pub people: Vec<ClosePerson>,
    pub units: Vec<ScopeUnit>,
    pub exit_cases: Vec<OpenExitCase>,
    pub job: Option<CloseJob>,
}

/// An entity refusal on the HR wire: same status, code and message; its
/// fields and remedy as `refusals`.
pub(crate) fn entity_error(error: PgEntityError) -> HrError {
    match error {
        PgEntityError::Refused(r) => HrError {
            errors: None,
            status: match r.kind {
                ErrorKind::Validation => StatusCode::UNPROCESSABLE_ENTITY,
                ErrorKind::NotFound => StatusCode::NOT_FOUND,
                ErrorKind::Forbidden => StatusCode::FORBIDDEN,
                ErrorKind::Conflict | ErrorKind::InvalidTransition => StatusCode::CONFLICT,
                ErrorKind::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
                ErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
            },
            code: r.code,
            message: r.message,
            refusals: (!r.fields.is_empty() || r.remedy.is_some())
                .then(|| json!([{ "fields": r.fields.iter().map(|f| json!({ "field": f.field, "code": f.code })).collect::<Vec<_>>(), "remedy": r.remedy }])).map(Box::new),
        },
        PgEntityError::Db(error) => {
            tracing::error!(%error, "workplace close: entity store fault");
            HrError::internal("internal server error")
        }
    }
}

/// 422 naming every line (or missing line) that refused, nothing written.
pub(crate) fn plan_refused(code: &'static str, refusals: Vec<Value>) -> HrError {
    HrError {
        errors: None,
        status: StatusCode::UNPROCESSABLE_ENTITY,
        code,
        message: format!(
            "{} lines of the close plan cannot be applied; nothing was changed",
            refusals.len()
        ),
        refusals: Some(Box::new(Value::Array(refusals))),
    }
}

pub(crate) fn conflict(code: &'static str, message: &str) -> HrError {
    HrError {
        errors: None,
        status: StatusCode::CONFLICT,
        code,
        message: message.to_owned(),
        refusals: None,
    }
}

/// 422 on one request field (`closed_on`).
pub(crate) fn field(name: &str, code: &'static str) -> HrError {
    HrError {
        errors: None,
        status: http::StatusCode::UNPROCESSABLE_ENTITY,
        code,
        message: format!("{name}: {code}"),
        refusals: Some(Box::new(json!([{ "field": name, "code": code }]))),
    }
}
