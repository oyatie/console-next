//! The lifecycle inputs the pure rules read: a normalised transition and the
//! employee head it meets.

use serde::{Deserialize, Serialize};
use time::Date;
use uuid::Uuid;

use super::classification::{Classification, ClassificationChange};
use super::signoffs::EmployeeLifecycleSignoffs;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedEmployeeLifecycleTransition {
    pub event_type: String,
    /// Empty only for CONTRACT_RENEWAL without an explicit `to_status`: the
    /// handler resolves it to the employee's current status (a renewal never
    /// changes status).
    pub to_status: String,
    pub to_company: Option<String>,
    pub to_org_unit: Option<String>,
    pub to_org_unit_id: Option<Uuid>,
    pub to_position: Option<String>,
    pub expected_return_date: Option<String>,
    pub contract_end_date: Option<String>,
    pub leave_type: Option<String>,
    /// PROMOTE by catalog id (BW-13); the label is projected into `to_position`.
    /// `serde(default)`: SCHEDULED rows stored before BW-13 still decode.
    #[serde(default)]
    pub to_job_title_id: Option<Uuid>,
    /// BW-07 reason code (`lifecycle_transfer` / `lifecycle_promote`).
    #[serde(default)]
    pub reason_code: Option<String>,
    /// TRANSFER (E-S3b): the workplace of the same legal entity the employee
    /// moves to (a transfer). `serde(default)`: SCHEDULED rows stored before
    /// E-S3b decode.
    #[serde(default)]
    pub to_workplace_id: Option<Uuid>,
    /// MR-24/25: a PROMOTE's grade, an APPOINT's position · job · job family,
    /// an employment type change's employment type. Flattened, every field
    /// defaults (older scheduled rows decode).
    #[serde(flatten)]
    pub classify: ClassificationChange,
    pub effective_date: String,
    pub comment: String,
    pub signoffs: EmployeeLifecycleSignoffs,
}

#[derive(Debug, Clone)]
pub struct EmployeeForLifecycle {
    pub company: String,
    pub org_unit: Option<String>,
    pub org_unit_id: Option<Uuid>,
    pub position: Option<String>,
    /// The catalog title behind `position` (BW-13), when it has one.
    pub job_title_id: Option<Uuid>,
    pub employment_status: String,
    /// `employee_employment_profiles.employment_type`; `None` for imported
    /// employees without a console-created profile (never CONTRACT).
    pub employment_type: Option<String>,
    /// The contract window's start; a renewal may not end before it.
    pub contract_start_date: Option<Date>,
    /// The contract window's end (MR-24: a rescinded employment type change
    /// restores it).
    pub contract_end_date: Option<Date>,
    /// MR-25: the current grade, position, job, job family and work-engaged-in
    /// text.
    pub classification: Classification,
}
