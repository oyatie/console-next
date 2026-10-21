//! Lifecycle request and page bodies (moved from `app/src/hr.rs`, R2-life).

use console_hr_domain::lifecycle::classification::ClassificationChange;
use console_hr_domain::lifecycle::signoffs::EmployeeLifecycleSignoffs;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::bulk_selection::{BulkSelection, BulkTransferLine};
use super::group_transfer::GroupTransferRequest;
use super::guards::RecordGuards;
use super::types::EmployeeLifecycleEventResponse;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreateEmployeeLifecycleEventRequest {
    #[serde(deserialize_with = "deserialize_enum_19")]
    pub event_type: String,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_enum_20")]
    pub to_status: Option<String>,
    #[serde(default)]
    pub to_company: Option<String>,
    #[serde(default)]
    pub to_org_unit: Option<String>,
    /// TRANSFER target: an ACTIVE Site/Department/Team; rebinds the employee
    /// and projects the unit name into `to_org_unit`.
    #[serde(default)]
    pub to_org_unit_id: Option<Uuid>,
    #[serde(default)]
    pub to_position: Option<String>,
    /// LEAVE_OF_ABSENCE only (optional): planned return date, ISO `YYYY-MM-DD`.
    #[serde(default)]
    pub expected_return_date: Option<String>,
    /// CONTRACT_RENEWAL only (required): renewed contract end, ISO `YYYY-MM-DD`.
    #[serde(default)]
    pub contract_end_date: Option<String>,
    /// LEAVE_OF_ABSENCE only (optional): CHILDCARE, MATERNITY, ILLNESS,
    /// PERSONAL, or OTHER.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leave_type: Option<String>,
    /// PROMOTE only (BW-13): the catalog title; wins over `to_position`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_job_title_id: Option<Uuid>,
    /// TRANSFER / PROMOTE only: a BW-07 code of `lifecycle_transfer` /
    /// `lifecycle_promote`; `comment` is its note.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    /// CONTRACT_RENEWAL only (BW-12): a FIXED_TERM_OVER_TWO_YEARS exception
    /// that admits a renewal past the fixed-term limit; consumed by it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exception_id: Option<Uuid>,
    /// TRANSFER only (E-S3b): the 사업장 of the same 법인 the employee moves
    /// to (전근). Without it, a unit placed at another 사업장 moves them there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_workplace_id: Option<Uuid>,
    /// GROUP_TRANSFER only (required then): the consent and the continuity
    /// choice of a 전적 (E-S3b).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_transfer: Option<GroupTransferRequest>,
    /// BW-11 version pins and the explicit replacement of a scheduled event.
    #[serde(flatten)]
    pub guards: RecordGuards,
    /// MR-24/25: PROMOTE `to_grade_id`; APPOINT `to_position_kind_id`,
    /// `vacate_position_kind`, `to_job_id`, `to_job`, `to_job_family_id`;
    /// EMPLOYMENT_TYPE_CHANGE `to_employment_type` (+ `contract_end_date` to
    /// CONTRACT).
    #[serde(flatten)]
    pub classify: ClassificationChange,
    pub effective_date: String,
    pub comment: String,
    /// Optional since A13: no lifecycle act requires an acknowledgement.
    #[serde(default)]
    pub signoffs: EmployeeLifecycleSignoffs,
}

#[derive(Debug, Serialize)]
pub struct EmployeeLifecycleEventPage {
    pub items: Vec<EmployeeLifecycleEventResponse>,
    /// The employee's version pin (BW-11): send it back as
    /// `expected_head_version` to refuse a write over an unseen change.
    pub head_version: i32,
    /// The cursor of the next (older) page; null on the last one.
    pub next_cursor: Option<String>,
}

/// Body of `POST /employees/{id}/lifecycle-events/{event_id}/cancel`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CancelLifecycleEventRequest {
    pub reason: String,
}

pub const MAX_BULK_EMPLOYEES: usize = 500;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BulkEmployeeLifecycleEventRequest {
    /// TRANSFER, PROMOTE, APPOINT or EMPLOYMENT_TYPE_CHANGE.
    #[serde(deserialize_with = "deserialize_enum_17")]
    pub event_type: String,
    /// Exactly one of `employee_ids`, `lines` or `selection` names the
    /// employees (`bulk_selection`).
    #[serde(default)]
    pub employee_ids: Vec<Uuid>,
    /// TRANSFER only, without `to_org_unit_id`: each employee's own unit.
    #[serde(default)]
    pub lines: Vec<BulkTransferLine>,
    /// Every employee the list filters admit, minus exclusions.
    #[serde(default)]
    pub selection: Option<BulkSelection>,
    /// TRANSFER: the ACTIVE Site/Department/Team every employee moves to.
    #[serde(default)]
    pub to_org_unit_id: Option<Uuid>,
    /// PROMOTE: the position every employee receives.
    #[serde(default)]
    pub to_position: Option<String>,
    /// PROMOTE (BW-13): the catalog title every employee receives.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_job_title_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    /// MR-24/25: the same fields as the single event, for every employee.
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
    #[serde(deserialize_with = "deserialize_enum_18")]
    pub to_employment_type: Option<String>,
    /// EMPLOYMENT_TYPE_CHANGE to CONTRACT: the new contract's end.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract_end_date: Option<String>,
    pub effective_date: String,
    pub comment: String,
    /// Optional since A13: no lifecycle act requires an acknowledgement.
    #[serde(default)]
    pub signoffs: EmployeeLifecycleSignoffs,
}

#[derive(Debug, Serialize)]
pub struct BulkEmployeeLifecycleEventResponse {
    pub batch_id: Uuid,
    /// One recorded event per employee, in `employee_ids` or `lines` order
    /// (a selection: employee id order).
    pub items: Vec<EmployeeLifecycleEventResponse>,
}

#[cfg(test)]
#[path = "requests_unknown_fields.rs"]
mod unknown_fields_tests;

fn deserialize_enum_17<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(
        deserializer,
        &[
            "TRANSFER",
            "PROMOTE",
            "APPOINT",
            "EMPLOYMENT_TYPE_CHANGE",
            "CONTRACT_RENEWAL",
        ],
    )
}

fn deserialize_enum_18<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
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

fn deserialize_enum_19<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(
        deserializer,
        &[
            "ONBOARD",
            "TRANSFER",
            "GROUP_TRANSFER",
            "PROMOTE",
            "APPOINT",
            "EMPLOYMENT_TYPE_CHANGE",
            "LEAVE_OF_ABSENCE",
            "RETURN_FROM_LEAVE",
            "CONTRACT_RENEWAL",
        ],
    )
}

fn deserialize_enum_20<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_optional_enum_string(
        deserializer,
        &["ACTIVE", "ON_LEAVE", "UNKNOWN"],
    )
}
