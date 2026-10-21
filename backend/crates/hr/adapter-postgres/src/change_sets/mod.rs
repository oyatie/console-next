//! BW-38: the server change set behind the grid and bulk 발령 edits. One draft
//! per (owner, intent); one line per employee, pinned to the `head_version` it
//! was drafted against; committed as one lifecycle batch (all or nothing, the
//! bulk path's rules per line) or discarded. Only the owner sees or touches a
//! set: anyone else gets 404, so a set's existence does not leak.
//!
//! Every route needs `employee_directory_manage` org-wide, the gate the bulk
//! lifecycle endpoint (the act a commit performs) uses.

mod commit;
mod lines;
mod store;

use console_hr_domain::lifecycle::classification::ClassificationChange;
use console_hr_domain::lifecycle::event::NormalizedEmployeeLifecycleTransition;
use console_hr_domain::lifecycle::signoffs::EmployeeLifecycleSignoffs;
use console_hr_domain::text::normalize_enum_text;
pub use console_platform_db::idempotency::IDEMPOTENCY_KEY_HEADER;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::HrError;
use crate::lifecycle::guards::RecordGuards;
use crate::lifecycle::normalize::normalize_lifecycle_transition;
use crate::lifecycle::requests::{CreateEmployeeLifecycleEventRequest, MAX_BULK_EMPLOYEES};
use crate::lifecycle::types::EmployeeLifecycleEventResponse;

/// The lines a set may hold: the bulk endpoint's ceiling, since a commit is one
/// bulk batch.
pub const MAX_CHANGE_SET_LINES: usize = MAX_BULK_EMPLOYEES;

/// Body of `POST /api/v1/change-sets`: opens the caller's draft for `intent`,
/// or returns the one already open.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenChangeSetRequest {
    /// TRANSFER, PROMOTE, APPOINT or EMPLOYMENT_TYPE_CHANGE.
    #[serde(deserialize_with = "deserialize_enum_8")]
    pub intent: String,
}

/// Body of `POST /api/v1/change-sets/{id}/lines`: drafts (or redrafts) the
/// line for one employee.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PutChangeSetLineRequest {
    pub employee_id: Uuid,
    /// The `head_version` the client read; omitted, the current one is pinned.
    #[serde(default)]
    pub expected_head_version: Option<i32>,
    pub effective_date: String,
    /// TRANSFER: the ACTIVE Site/Department/Team.
    #[serde(default)]
    pub to_org_unit_id: Option<Uuid>,
    /// PROMOTE: the catalog title (wins over `to_position`).
    #[serde(default)]
    pub to_job_title_id: Option<Uuid>,
    /// PROMOTE: free-text position.
    #[serde(default)]
    pub to_position: Option<String>,
    #[serde(default)]
    pub reason_code: Option<String>,
    /// MR-24/25 fields, the single event's rules per kind (MR-27): PROMOTE
    /// `to_grade_id`; APPOINT `to_position_kind_id`, `vacate_position_kind`,
    /// `to_job_id`, `to_job`, `to_job_family_id`; EMPLOYMENT_TYPE_CHANGE
    /// `to_employment_type` (+ `contract_end_date` to CONTRACT).
    #[serde(default, flatten)]
    pub classify: LineClassification,
    pub comment: String,
}

/// A line's MR-24/25 values, as drafted and as read back. Unknown keys are
/// refused by the outer request (pinned by the test below).
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct LineClassification {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_grade_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_position_kind_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub vacate_position_kind: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_job_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_job: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_job_family_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(deserialize_with = "deserialize_enum_7")]
    pub to_employment_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract_end_date: Option<String>,
}

impl LineClassification {
    fn change(&self) -> ClassificationChange {
        ClassificationChange {
            to_grade_id: self.to_grade_id,
            to_position_kind_id: self.to_position_kind_id,
            vacate_position_kind: self.vacate_position_kind,
            to_job_id: self.to_job_id,
            to_job: self.to_job.clone(),
            to_job_family_id: self.to_job_family_id,
            to_employment_type: self.to_employment_type.clone(),
        }
    }
}

/// Body of `POST /api/v1/change-sets/{id}/commit`.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CommitChangeSetRequest {
    pub signoffs: EmployeeLifecycleSignoffs,
}

#[derive(Debug, Serialize)]
pub struct ChangeSetSummary {
    pub id: Uuid,
    pub intent: String,
    /// OPEN, COMMITTED or DISCARDED.
    pub state: String,
    /// The lifecycle batch a commit recorded.
    pub batch_id: Option<Uuid>,
    /// 「저장 안 됨 · n건」: the lines not yet committed.
    pub line_count: i64,
    /// Lines whose employee changed since they were drafted (a commit refuses them).
    pub stale_count: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

#[derive(Debug, Serialize)]
pub struct ChangeSetLine {
    pub id: Uuid,
    pub employee_id: Uuid,
    pub expected_head_version: i32,
    /// The employee's version now; differs from the pin when `stale`.
    pub head_version: i32,
    pub stale: bool,
    /// Lines on this employee in other OPEN drafts (anyone's).
    pub other_open_drafts: i64,
    pub effective_date: String,
    pub to_org_unit_id: Option<Uuid>,
    pub to_job_title_id: Option<Uuid>,
    pub to_position: Option<String>,
    pub reason_code: Option<String>,
    #[serde(flatten)]
    pub classify: LineClassification,
    pub comment: String,
}

#[derive(Debug, Serialize)]
pub struct ChangeSetDetail {
    #[serde(flatten)]
    pub summary: ChangeSetSummary,
    pub lines: Vec<ChangeSetLine>,
}

#[derive(Debug, Serialize)]
pub struct ChangeSetCommitResponse {
    pub change_set_id: Uuid,
    pub batch_id: Uuid,
    /// One recorded event per line, in employee-id order.
    pub items: Vec<EmployeeLifecycleEventResponse>,
}

/// A kind the bulk lifecycle endpoint takes, else 422.
fn normalize_intent(intent: &str) -> Result<String, HrError> {
    let intent = normalize_enum_text(intent.to_owned());
    if matches!(
        intent.as_str(),
        "TRANSFER" | "PROMOTE" | "APPOINT" | "EMPLOYMENT_TYPE_CHANGE"
    ) {
        Ok(intent)
    } else {
        Err(HrError::validation(
            "intent must be TRANSFER, PROMOTE, APPOINT or EMPLOYMENT_TYPE_CHANGE",
        ))
    }
}

/// A line as the single-event rules see it: the bulk endpoint's per-kind
/// field rules, then `normalize_lifecycle_transition` (dates, comment length,
/// reason placement).
fn line_transition(
    intent: &str,
    line: &PutChangeSetLineRequest,
    signoffs: EmployeeLifecycleSignoffs,
) -> Result<NormalizedEmployeeLifecycleTransition, HrError> {
    // The bulk endpoint's placement rules; normalize_lifecycle_transition
    // owns the per-kind rules of the MR-24/25 fields.
    if intent == "TRANSFER" && line.to_org_unit_id.is_none() {
        return Err(HrError::validation(
            "to_org_unit_id is required for TRANSFER",
        ));
    }
    if intent != "PROMOTE" && (line.to_position.is_some() || line.to_job_title_id.is_some()) {
        return Err(HrError::validation(
            "to_position is only allowed for PROMOTE",
        ));
    }
    if intent != "TRANSFER" && line.to_org_unit_id.is_some() {
        return Err(HrError::validation(
            "to_org_unit_id is only allowed for TRANSFER",
        ));
    }
    if line
        .to_position
        .as_deref()
        .is_some_and(|p| p.trim().chars().count() > 200)
    {
        return Err(HrError::validation(
            "to_position must be 200 characters or fewer",
        ));
    }
    normalize_lifecycle_transition(CreateEmployeeLifecycleEventRequest {
        event_type: intent.to_owned(),
        to_status: None,
        to_company: None,
        to_org_unit: None,
        to_org_unit_id: line.to_org_unit_id,
        to_position: line.to_position.clone(),
        expected_return_date: None,
        contract_end_date: line.classify.contract_end_date.clone(),
        leave_type: None,
        to_job_title_id: line.to_job_title_id,
        reason_code: line.reason_code.clone(),
        exception_id: None,
        to_workplace_id: None,
        group_transfer: None,
        guards: RecordGuards::default(),
        classify: line.classify.change(),
        effective_date: line.effective_date.clone(),
        comment: line.comment.clone(),
        signoffs,
    })
}

fn deserialize_enum_7<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_optional_enum_string(
        deserializer,
        &[
            "REGULAR",
            "CONTRACT",
            "PART_TIME",
            "INTERN",
            "DAILY",
            "EXECUTIVE",
            "DISPATCHED_IN",
            "OUTSOURCED_ON_SITE",
            "FREELANCE",
        ],
    )
}

fn deserialize_enum_8<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(
        deserializer,
        &["TRANSFER", "PROMOTE", "APPOINT", "EMPLOYMENT_TYPE_CHANGE"],
    )
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::PutChangeSetLineRequest;
    use serde_json::json;

    fn line(extra: serde_json::Value) -> serde_json::Result<PutChangeSetLineRequest> {
        let mut body = json!({
            "employee_id": uuid::Uuid::nil(),
            "effective_date": "2026-10-01",
            "comment": "",
        });
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(body)
    }

    #[test]
    fn a_line_takes_the_classification_fields_and_refuses_unknown_keys() {
        let parsed =
            line(json!({ "to_employment_type": "CONTRACT", "vacate_position_kind": true }))
                .unwrap();
        assert_eq!(
            parsed.classify.to_employment_type.as_deref(),
            Some("CONTRACT")
        );
        assert!(parsed.classify.vacate_position_kind);
        assert!(line(json!({ "to_grade": "x" })).is_err());
    }
}
