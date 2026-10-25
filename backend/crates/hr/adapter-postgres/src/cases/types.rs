// SPDX-License-Identifier: LicenseRef-Proprietary
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct TemplateItem {
    pub item_key: String,
    pub label: String,
    pub label_key: Option<String>,
    pub kind: String,
    pub owner_line: Option<String>,
    pub rule_ref: Option<String>,
    pub instrument: Option<String>,
    pub article: Option<String>,
    pub blocks_close: bool,
    pub legal_review_required: bool,
    pub due_rule_kind: String,
    pub due_anchor: Option<String>,
    pub opens_rule_ref: Option<String>,
    pub insurer: Option<String>,
    pub filing_kind: Option<String>,
    pub opens_anchor: Option<String>,
    pub opens_offset_days: Option<i32>,
    pub due_rule_value: Option<i64>,
    #[sqlx(skip)]
    pub opens_on: Option<String>,
    #[sqlx(skip)]
    pub due_on: Option<String>,
    #[sqlx(skip)]
    pub opens_in_days: Option<i64>,
    #[sqlx(skip)]
    pub due_in_days: Option<i64>,
    #[sqlx(skip)]
    pub due_disposition: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct TemplatePreviewQuery {
    pub variant: Option<String>,
    pub exit_reason: Option<String>,
    pub effective_date: Option<time::Date>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct CaseItem {
    pub id: Uuid,
    pub case_id: Uuid,
    pub item_key: String,
    pub label: String,
    pub label_key: Option<String>,
    pub kind: String,
    pub owner_line: Option<String>,
    pub status: String,
    pub completion_rule_ref: Option<String>,
    pub waiver_rule_ref: Option<String>,
    pub record_target: Option<String>,
    #[sqlx(skip)]
    pub completion_risk: Option<String>,
    pub status_code: Option<String>,
    pub opens_on: Option<String>,
    pub opens_in_days: Option<i64>,
    pub due_date: Option<String>,
    pub due_in_days: Option<i64>,
    pub due_disposition: String,
    pub due_rule_ref: Option<String>,
    pub opens_rule_ref: Option<String>,
    pub basis: Value,
    pub blocks_close: bool,
    pub observed_ref: Option<Value>,
    pub exception_id: Option<Uuid>,
    pub completion_reason: Option<String>,
    pub filing_obligation_id: Option<Uuid>,
    pub filing_kind: Option<String>,
    pub insurer: Option<String>,
    pub version: i64,
}

#[derive(Debug, Serialize)]
pub struct LifecycleCase {
    pub id: Uuid,
    pub employee_id: Uuid,
    pub kind: String,
    pub state: String,
    pub trigger_id: Option<Uuid>,
    pub effective_date: String,
    pub linked_case_id: Option<Uuid>,
    pub cancellation_reason: Option<String>,
    pub version: i64,
    pub items: Vec<CaseItem>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompleteItem {
    pub expected_version: i64,
    pub due_date: Option<Value>,
    pub observed_ref: Option<Value>,
    pub exception_id: Option<Uuid>,
    #[serde(default)]
    pub waive: bool,
    pub reason: Option<String>,
    pub attestation: Option<ItemAttestation>,
    pub step_up: Option<console_platform_auth::MobilePasskeyStepUpEnvelope>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ItemAttestation {
    pub fact_date: String,
    pub document: EvidenceDocument,
    pub reason_code: String,
    pub note: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceDocument {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Default, Deserialize)]
pub struct CaseItemQuery {
    pub after: Option<Uuid>,
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct CaseItemPage {
    pub items: Vec<CaseItem>,
    pub next: Option<Uuid>,
}
