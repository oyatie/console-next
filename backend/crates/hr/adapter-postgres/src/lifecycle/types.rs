//! The lifecycle event read model.

use console_hr_domain::lifecycle::classification::ClassificationColumns;
use console_hr_domain::lifecycle::signoffs::EmployeeLifecycleSignoffs;
use serde::Serialize;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, Serialize)]
pub struct EmployeeLifecycleEventResponse {
    pub id: Uuid,
    pub employee_id: Uuid,
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_status: Option<String>,
    pub to_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_company: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_company: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_org_unit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_org_unit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_position: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_position: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_return_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contract_end_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leave_type: Option<String>,
    /// The bulk appointment that recorded this event, when it was one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<Uuid>,
    /// SCHEDULED (dated after today, KST), APPLIED, APPLY_FAILED, or CANCELLED.
    pub state: String,
    #[serde(
        skip_serializing_if = "Option::is_none",
        with = "time::serde::rfc3339::option"
    )]
    pub applied_at: Option<OffsetDateTime>,
    /// APPLY_FAILED only: the refusal code and message from its date.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<String>,
    /// CANCELLED only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled_by: Option<Uuid>,
    /// The canceller's display name within the tenant (CANCELLED by hand only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled_by_name: Option<String>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        with = "time::serde::rfc3339::option"
    )]
    pub cancelled_at: Option<OffsetDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancel_reason: Option<String>,
    /// CANCELLED by a correction: the SCHEDULED event that replaced it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<Uuid>,
    /// BW-07 reason code of a TRANSFER or PROMOTE (BW-13); `comment` is its note.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    /// PROMOTE: the catalog titles before and after (BW-13).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_job_title_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_job_title_id: Option<Uuid>,
    /// BW-11: the event this row corrects (same type) or rescinds (RESCIND).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voids_event_id: Option<Uuid>,
    /// BW-11: the correction or RESCIND row that voided this event.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voided_by: Option<Uuid>,
    /// TRANSFER (E-S3b): the 사업장 of the same 법인 it moves the employee to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_workplace_id: Option<Uuid>,
    /// GROUP_TRANSFER (E-S3b): the facts recorded with the 전적.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_transfer: Option<GroupTransferView>,
    /// MR-24/25: PROMOTE `from/to_grade_id`; APPOINT `from/to_position_kind_id`,
    /// `from/to_job_id`, `from/to_job`, `from/to_job_family_id`;
    /// EMPLOYMENT_TYPE_CHANGE `from/to_employment_type` (flattened, absent
    /// fields omitted).
    #[serde(flatten)]
    pub classification: ClassificationColumns,
    pub effective_date: String,
    pub comment: String,
    /// Catalog code for a system-authored line; absent on legacy and user-written notes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment_code: Option<String>,
    pub signoffs: EmployeeLifecycleSignoffs,
    pub created_by: Uuid,
    /// The recorder's display name within the tenant; null when unknown.
    pub created_by_name: Option<String>,
    pub actor_kind: Option<String>,
    pub command_id: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: time::OffsetDateTime,
}

/// The facts of a 전적, as read back.
#[derive(Debug, Serialize)]
pub struct GroupTransferView {
    pub from_legal_entity_id: Uuid,
    pub to_legal_entity_id: Uuid,
    /// 퇴직금: SETTLED or CARRIED.
    pub continuity: String,
    /// 연차: SETTLED or CARRIED.
    pub annual_leave_continuity: String,
    /// 근속: RESTART or CARRIED.
    pub seniority_continuity: String,
    /// The sending 법인's settlement case the 전적 opened (퇴직금 settled there).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settlement_case_id: Option<Uuid>,
    pub group_service_start_date: String,
    pub consent_date: String,
    /// Omitted from the read-only view.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consent_evidence_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub succession_evidence_ref: Option<String>,
}

impl EmployeeLifecycleEventResponse {
    /// The read-only (`employee_directory_read` without manage) view: the
    /// leave type (ILLNESS and MATERNITY reveal health, 개보법 제23조) and the
    /// free-text cancel reason are omitted.
    pub fn redact_for_reader(mut self) -> Self {
        self.leave_type = None;
        self.cancel_reason = None;
        if let Some(facts) = self.group_transfer.as_mut() {
            facts.consent_evidence_ref = None;
            facts.succession_evidence_ref = None;
        }
        self
    }
}
