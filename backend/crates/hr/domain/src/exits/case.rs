//! Exit-case statuses and the case context the settlement and payload
//! builders read (moved from `app/src/hr.rs`, R2-exits).

use uuid::Uuid;

pub const EXIT_CASE_STATUSES: [&str; 8] = [
    "REPORTED",
    "HR_CONFIRMED",
    "HQ_CONFIRMED",
    "SETTLEMENT_READY",
    "APPROVAL_DRAFTED",
    "SUBMITTED",
    "REJECTED",
    "CANCELLED",
];

#[derive(Debug, Clone)]
pub struct ExitCaseContext {
    pub id: Uuid,
    pub employee_id: Uuid,
    pub employee_name: String,
    pub employee_number: Option<String>,
    pub company: String,
    pub org_unit: Option<String>,
    pub position: Option<String>,
    pub worksite_name: Option<String>,
    pub hire_date: Option<String>,
    pub branch_id: Option<Uuid>,
    pub branch_name: Option<String>,
    pub status: String,
    /// Who recorded the first-tier (HR) confirmation, if any. Authoritative
    /// input to the two-tier separation-of-duties check in the confirm handler:
    /// the HQ confirmer must differ from this actor.
    pub hr_confirmed_by: Option<Uuid>,
    pub effective_exit_date: String,
    pub site_manager_note: String,
}
