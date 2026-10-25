//! Directory request and response types (moved from `app/src/hr.rs`,
//! R2-people).

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

pub use crate::directory::create_types::{CreateEmployeeRequest, NormalizedCreateEmployeeRequest};
use crate::directory::read_detail::AllowedLifecycleEvent;

#[derive(Debug, Serialize)]
pub struct EmployeePage {
    pub items: Vec<EmployeeResponse>,
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
    /// Keyset reads (`sort` or `cursor` given): the cursor of the next page,
    /// null on the last one. Always null for an offset read.
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct EmployeeResponse {
    pub person_id: Option<Uuid>,
    pub id: Uuid,
    pub company: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub employee_number: Option<String>,
    /// Read-only projection: the bound unit's name for bound rows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_unit: Option<String>,
    /// Canonical OrgUnit binding (0242); null when unbound (legacy/imported).
    pub org_unit_id: Option<Uuid>,
    /// 법인 and 사업장 by id from the employee's current (or last) employment
    /// assignment; null when none is recorded. `company` / `worksite_name`
    /// stay display snapshots (E-S3a).
    pub legal_entity_id: Option<Uuid>,
    pub workplace_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worksite_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worksite: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hire_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Effective date on which the current status began.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_since: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leave_accrued: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leave_used: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leave_remaining: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub home_branch_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub home_branch_name: Option<String>,
    /// Deprecated compatibility name: no current primary assignment to a workplace.
    pub home_branch_review_required: bool,
    pub register_review_required: bool,
    pub identity_resolution_strategy: String,
    pub identity_resolution_confidence: String,
    pub identity_review_required: bool,
    pub identity_name_only_merge: bool,
    /// Current fixed-term contract end (`YYYY-MM-DD`); absent unless the
    /// employee has a CONTRACT employment profile carrying one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contract_end_date: Option<String>,
    /// The employment profile's type (REGULAR, CONTRACT, …); absent for a
    /// roster-import row with no profile.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub employment_type: Option<String>,
    /// While ON_LEAVE: the expected return date (`YYYY-MM-DD`) of the leave
    /// that put them there; absent otherwise or when the leave named none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_return_date: Option<String>,
    /// 업무용 이메일: the only contact the directory row carries (G11). The
    /// registered personal phone stays on `employment.phone_e164`, managers only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_email: Option<String>,
    /// The nearest SCHEDULED lifecycle event (발령 효력 예정); null when none.
    pub next_event: Option<EmployeeNextEvent>,
    /// The latest scheduled action that could not apply on its date and was
    /// not redone since (no SCHEDULED or APPLIED event of the same kind was
    /// recorded after it); null when none or once the employee has exited.
    pub failed_event: Option<EmployeeFailedEvent>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: time::OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: time::OffsetDateTime,
}

#[derive(Debug, Serialize)]
pub struct EmployeeNextEvent {
    pub id: Uuid,
    pub event_type: String,
    pub effective_date: String,
}

#[derive(Debug, Serialize)]
pub struct EmployeeFailedEvent {
    pub id: Uuid,
    pub event_type: String,
    pub effective_date: String,
    pub failure_code: String,
}

/// A non-blocking notice on a created employee (`warnings[]`).
#[derive(Debug, Serialize)]
pub struct EmployeeCreateWarning {
    /// `same_name_in_unit`: other non-exited employees in the same unit share
    /// the name. `pay_below_minimum_wage`: the pay of a 근로자 is below the
    /// 최저임금 floor (`floor_won`) in force on the hire date.
    pub code: &'static str,
    /// Empty for `pay_below_minimum_wage` (kept, so existing clients that
    /// read it as a list keep working).
    pub employee_ids: Vec<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub floor_won: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EmployeeEmploymentDetail {
    pub employment_type: Option<String>,
    /// Omitted for callers without `employee_directory_manage`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone_e164: Option<String>,
    /// Omitted for callers without `employee_directory_manage`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_pay: Option<String>,
    pub currency: String,
    /// CONTRACT window (`YYYY-MM-DD`); null when not a fixed-term contract or
    /// registered before contract dates were recorded.
    pub contract_start_date: Option<String>,
    pub contract_end_date: Option<String>,
}

#[derive(Debug, Default, Serialize)]
pub struct EmployeeClassification {
    pub grade_id: Option<Uuid>,
    pub job_title_id: Option<Uuid>,
    pub position_kind_id: Option<Uuid>,
    pub job_id: Option<Uuid>,
    pub job_family_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
pub struct EmployeeDetailResponse {
    pub employee: EmployeeResponse,
    /// Null when the employee has no employment profile yet (roster import
    /// rows are created without one).
    #[serde(serialize_with = "serialize_classified_employment")]
    pub employment: Option<EmployeeEmploymentDetail>,
    /// Expand: facts recorded before classification, without changing the N-1 profile.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_employment: Option<EmployeeEmploymentDetail>,
    /// Lifecycle events recordable now (empty once EXITED, and for callers
    /// without `employee_directory_manage`). Exits are not listed: they go
    /// through `/api/v1/hr/exit-cases`.
    pub allowed_events: Vec<AllowedLifecycleEvent>,
    /// Lifecycle events schedulable for a date after `schedule_after`: those
    /// the employee admits as they will stand after their last SCHEDULED event
    /// (a return after a scheduled leave). Empty when nothing is scheduled
    /// (`allowed_events` then covers every date), once an exit is scheduled,
    /// and for callers without `employee_directory_manage`.
    pub allowed_scheduled_events: Vec<AllowedLifecycleEvent>,
    /// The date of the employee's last SCHEDULED event; null when none.
    pub schedule_after: Option<String>,
    /// MR-25: the current 직급, 직위, 직책, 직무 and 직군 catalog ids (labels
    /// from `GET /api/v1/job-titles`); null when none.
    pub classification: EmployeeClassification,
    /// Non-blocking notices on registration and current detail reads.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<EmployeeCreateWarning>,
}

impl EmployeeDetailResponse {
    /// The created (or replayed) employee id, for callers that link the
    /// employee object without re-reading the row.
    pub fn employee_id(&self) -> Uuid {
        self.employee.id
    }

    pub fn employee_home_branch_id(&self) -> Option<Uuid> {
        self.employee.home_branch_id
    }

    /// CAS token for the command-side home-branch assignment.
    pub fn employee_updated_at(&self) -> time::OffsetDateTime {
        self.employee.updated_at
    }

    /// The read-only (`employee_directory_read` without manage) view: contact
    /// and pay are omitted, and nothing is recordable.
    pub fn redact_for_reader(mut self) -> Self {
        for employment in self
            .employment
            .iter_mut()
            .chain(self.pending_employment.iter_mut())
        {
            employment.phone_e164 = None;
            employment.base_pay = None;
        }
        self.allowed_events.clear();
        self.allowed_scheduled_events.clear();
        self.warnings
            .retain(|warning| warning.code != "pay_below_minimum_wage");
        self
    }
}

fn serialize_classified_employment<S: serde::Serializer>(
    value: &Option<EmployeeEmploymentDetail>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    value
        .as_ref()
        .filter(|profile| profile.employment_type.is_some())
        .serialize(serializer)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetEmployeeHomeBranchRequest {
    pub branch_id: Uuid,
    /// Optimistic concurrency precondition from the employee list/read model.
    pub expected_updated_at: String,
}

#[derive(Debug, Serialize)]
pub struct EmployeeHomeBranchResponse {
    pub employee_id: Uuid,
    pub branch_id: Uuid,
    pub branch_name: String,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}
