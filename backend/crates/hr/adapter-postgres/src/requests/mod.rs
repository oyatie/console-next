//! BW-17 change requests (변경 요청): create, list, decide and the assignee's
//! action-inbox page. Lane PEOPLE-A.

pub mod cedar;
pub mod create;
pub mod decide;
pub mod inbox;
pub mod read;

use http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::HrError;

/// The only assignee role today: org-wide employee-directory managers (HR).
pub const ASSIGNEE_ROLE_HR: &str = "HR";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateChangeRequest {
    #[serde(deserialize_with = "deserialize_enum_22")]
    pub kind: String,
    #[serde(deserialize_with = "deserialize_enum_23")]
    pub subject_type: String,
    pub subject_id: Uuid,
    /// PROFILE_CORRECTION: `{ "changes": { <field>: <value> }, "expected_updated_at"? }`.
    #[serde(default)]
    pub payload: Option<Value>,
    pub reason_code: String,
    #[serde(default)]
    pub note: Option<String>,
    /// One named HR person; otherwise any HR person may take it.
    #[serde(default)]
    pub assignee_user_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DecideChangeRequest {
    /// `APPLY`, `DECLINE` (a second person) or `WITHDRAW` (the requester).
    #[serde(deserialize_with = "deserialize_enum_24")]
    pub decision: String,
    pub reason_code: String,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ChangeRequestListQuery {
    /// `me`: named to the caller; `role`: open to any HR person. HR only.
    pub assignee: Option<String>,
    /// `me`: only the requests the caller filed (its 기다리는 중).
    pub requester: Option<String>,
    pub status: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct ChangeRequestResponse {
    pub id: Uuid,
    pub kind: String,
    pub subject_type: String,
    pub subject_id: Uuid,
    pub payload: Value,
    pub reason_code: String,
    pub note: Option<String>,
    pub requested_by: Uuid,
    pub assignee_role: String,
    pub assignee_user_id: Option<Uuid>,
    pub status: String,
    /// OTHER requests are reviewed after the fact (the 기타 path).
    pub review_required: bool,
    pub decided_by: Option<Uuid>,
    pub decision_reason_code: Option<String>,
    pub decision_note: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub decided_at: Option<OffsetDateTime>,
}

#[derive(Debug, Serialize)]
pub struct ChangeRequestPage {
    pub items: Vec<ChangeRequestResponse>,
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
}

fn refusal(status: StatusCode, code: &'static str, message: &str) -> HrError {
    HrError {
        errors: None,
        status,
        code,
        message: message.to_owned(),
        refusals: None,
    }
}

/// Trimmed reason code, 1..=100 characters (the column CHECK).
pub(crate) fn reason_code(raw: &str, field: &str) -> Result<String, HrError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 100 {
        return Err(HrError::validation(format!(
            "{field} must be 1 to 100 characters"
        )));
    }
    Ok(trimmed.to_owned())
}

/// Optional note: blank is absent, at most 1000 characters (the column CHECK).
pub(crate) fn note(raw: Option<&str>) -> Result<Option<String>, HrError> {
    match raw.map(str::trim).filter(|note| !note.is_empty()) {
        Some(note) if note.chars().count() > 1000 => {
            Err(HrError::validation("note must be at most 1000 characters"))
        }
        other => Ok(other.map(str::to_owned)),
    }
}

fn deserialize_enum_22<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(
        deserializer,
        &[
            "PROFILE_CORRECTION",
            "IDENTITY_REVIEW",
            "ACCESS_REQUEST",
            "SCOPE_ACTION",
            "OTHER",
            "ACCESS_EXPLANATION",
            "POLICY_QUESTION",
        ],
    )
}

fn deserialize_enum_23<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(
        deserializer,
        &["EMPLOYEE", "USER_ACCOUNT", "BRANCH", "ORGANIZATION"],
    )
}

fn deserialize_enum_24<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(
        deserializer,
        &["APPLY", "DECLINE", "WITHDRAW"],
    )
}
