use console_compliance_domain::statutory::filing::{
    Applicability, FilingDates, FilingFacts, FilingRule, Reason,
};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, Clone, Default, Deserialize)]
pub struct FilingQuery {
    pub workplace_id: Option<Uuid>,
    pub legal_entity_id: Option<Uuid>,
    pub search: Option<String>,
    pub state: Option<String>,
    pub after: Option<String>,
    pub limit: Option<usize>,
    pub event_id: Option<Uuid>,
    pub filing_id: Option<Uuid>,
    pub insurer: Option<String>,
    pub kind: Option<String>,
    #[serde(skip)]
    pub inbox_as_of: Option<OffsetDateTime>,
    #[serde(skip)]
    pub inbox_after: Option<(OffsetDateTime, String)>,
    #[serde(skip)]
    pub inbox_scan_limit: Option<usize>,
}
#[derive(Debug, Serialize)]
pub struct LossOption {
    pub code: String,
    pub label: String,
    pub requires_detail: bool,
    pub held: bool,
}
#[derive(Debug, Serialize)]
pub struct FilingTask {
    #[serde(skip)]
    pub created_at: OffsetDateTime,
    pub event_id: Uuid,
    pub filing_obligation_id: Option<Uuid>,
    pub lifecycle_case_id: Option<Uuid>,
    pub employee_id: Uuid,
    pub name: String,
    pub employee_number: Option<String>,
    pub kind: String,
    pub insurer: String,
    pub effective_date: String,
    pub legal_entity_id: Option<Uuid>,
    pub workplace_id: Option<Uuid>,
    pub workplace_name: Option<String>,
    pub due_date: Option<String>,
    pub due_in_days: Option<i64>,
    pub deadline_status: String,
    pub version: i64,
    pub completed_on: Option<String>,
    pub receipt_number: Option<String>,
    pub loss_code: Option<String>,
    pub loss_options: Vec<LossOption>,
    pub detail: Option<String>,
    pub opens_on: Option<String>,
    pub opens_in_days: Option<i64>,
    pub target_on: Option<String>,
    pub due_on: Option<String>,
    pub dates: Option<FilingDates>,
    pub basis: Option<FilingRule>,
    pub applicability: Applicability,
    pub applicability_facts: FilingFacts,
    pub state: String,
    pub record_action: Option<String>,
    pub can_record_sensitive_facts: bool,
    pub birth_date_known: bool,
    #[serde(skip)]
    pub(crate) birth_date_for_assessment: Option<String>,
    pub not_applicable_reason: Option<Reason>,
    pub total_remuneration_won: Option<i64>,
    pub is_request: bool,
    pub acquired_on: Option<String>,
    pub not_applicable_options: Vec<Reason>,
}
#[derive(Debug, Serialize)]
pub struct FilingPage {
    pub items: Vec<FilingTask>,
    pub total: i64,
    pub pending: i64,
    pub next: Option<String>,
}

impl FilingTask {
    pub fn resolved(&self) -> bool {
        ["DONE", "NOT_APPLICABLE", "COVERED"].contains(&self.state.as_str())
    }
    pub fn inbox_id(&self) -> String {
        format!(
            "insurance_filing_{}_{}:{}",
            self.kind, self.insurer, self.event_id
        )
    }
}
