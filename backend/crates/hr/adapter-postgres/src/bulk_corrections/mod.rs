//! MR-27: bulk 정정 of scalar employee fields, the grid and the
//! 「필터와 일치하는 n명 모두」 selection (decisions #21: every field editable
//! through the bulk path too). Lane LIFE.
//!
//! - **Selection** is server-side: the `GET /employees` filters plus
//!   exclusions, resolved by the server at preview and again at commit
//!   (never the rows a client happened to load). A grid sends `rows` instead,
//!   each employee with its own values and optional `updated_at` pin.
//! - **Preview** reads without locks and answers the exact counts and every
//!   row: CHANGE, PENDING (a field waits for a second person), UNCHANGED or
//!   REFUSED with the precondition that failed. Its digest binds the commit.
//! - **Commit** is one job in one transaction: the employees are locked in id
//!   order, the preview is recomputed and must match the digest (else 409
//!   `rows_changed_since_preview` with the fresh preview), then every row is
//!   written through MR-8's ledger (`apply_fields_in_tx`), the one writer of
//!   scalar employee fields. High-risk fields follow the single PATCH's
//!   rules: a BW-17 request per employee, or the sole holder's step-up bound
//!   to the preview, with the review flag.
//!
//! Every route needs `employee_directory_manage` org-wide, as the PATCH does.

mod commit;
mod plan;
mod read;
mod select;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

pub use console_platform_db::idempotency::IDEMPOTENCY_KEY_HEADER;

/// The rows one bulk correction may touch.
// a constant ceiling and one synchronous transaction (design C12);
// the registry key `bulk.selection_max` and a worker job come when the
// 30,000-row perf gate needs them.
pub const MAX_BULK_CORRECTION_ROWS: usize = 5_000;

/// The `GET /employees` filters a selection resolves (no paging). Unknown
/// keys are refused: a misspelt filter must not widen the selection to everyone.
#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SelectionFilter {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub company: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home_branch_review_required: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_review_required: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub register_review_required: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org_unit_id: Option<Uuid>,
    /// Comma-separated statuses. Absent: everyone but EXITED (a 퇴직자 is
    /// selected only when asked for).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract_ending_before: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifecycle_apply_failed: Option<bool>,
}

/// 「필터와 일치하는 n명 모두 선택」 with individual unticks.
#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BulkSelection {
    #[serde(default)]
    pub filter: SelectionFilter,
    #[serde(default)]
    pub exclude_ids: Vec<Uuid>,
}

/// One grid row: an employee and the values typed for them.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BulkCorrectionRow {
    pub employee_id: Uuid,
    pub changes: Map<String, Value>,
    /// The employee's `updated_at` as the grid read it (RFC 3339); a row
    /// changed since is refused (`stale_record`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_updated_at: Option<String>,
}

/// Body of the preview and the commit. Either `selection` with `changes` (one
/// set of values for everyone selected) or `rows` (the grid), never both.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BulkCorrectionRequest {
    #[serde(default)]
    pub selection: Option<BulkSelection>,
    #[serde(default)]
    pub changes: Option<Map<String, Value>>,
    #[serde(default)]
    pub rows: Vec<BulkCorrectionRow>,
    pub reason_code: String,
    #[serde(default)]
    pub note: Option<String>,
    /// Commit only (required there): the digest of the preview the person saw.
    #[serde(default)]
    pub preview_digest: Option<String>,
    /// Commit only: a sole holder's step-up, bound to `preview_id` and
    /// `preview_digest` (EXCEPTION_DECIDE, as the single PATCH signs).
    #[serde(default)]
    pub step_up: Option<console_platform_auth::MobilePasskeyStepUpEnvelope>,
}

impl BulkCorrectionRequest {
    /// The idempotency fingerprint: the request without the step-up, which
    /// differs on every attempt.
    fn fingerprint(&self) -> Value {
        json!({
            "selection": &self.selection,
            "changes": &self.changes,
            "rows": &self.rows,
            "reason_code": &self.reason_code,
            "note": &self.note,
            "preview_digest": &self.preview_digest,
        })
    }
}

#[derive(Debug, Default, Clone, Serialize, PartialEq, Eq)]
pub struct BulkCorrectionCounts {
    pub selected: usize,
    pub change: usize,
    pub pending: usize,
    pub unchanged: usize,
    pub refused: usize,
}

/// One field that differs from the record.
#[derive(Debug, Clone, Serialize)]
pub struct BulkCorrectionField {
    pub field: String,
    pub before: Option<String>,
    pub after: Option<String>,
    /// NOW, SECOND_PERSON or SOLE_HOLDER_REVIEW.
    pub path: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct BulkCorrectionPreviewRow {
    pub employee_id: Uuid,
    pub name: Option<String>,
    pub employee_number: Option<String>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub updated_at: Option<OffsetDateTime>,
    /// CHANGE, PENDING, UNCHANGED or REFUSED.
    pub outcome: &'static str,
    /// Only the fields whose value differs.
    pub fields: Vec<BulkCorrectionField>,
    /// REFUSED: the first refusal's code and message (see `refusals`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// REFUSED: every refusal, each naming its field (EMP-UI 13).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub refusals: Vec<BulkCorrectionRefusal>,
}

/// Why a row (or one of its fields) cannot be written.
#[derive(Debug, Clone, Serialize)]
pub struct BulkCorrectionRefusal {
    /// The field; `None` for the whole row (stale pin, unknown employee, or
    /// dates that disagree across two fields).
    pub field: Option<String>,
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct BulkCorrectionPreview {
    /// The job id the commit records; the sole holder's step-up binds it.
    pub preview_id: Uuid,
    /// SHA-256 hex the commit sends back; the step-up's `payload_hash`.
    pub preview_digest: String,
    pub counts: BulkCorrectionCounts,
    /// A sole holder commits a high-risk field: the commit needs `step_up`.
    pub step_up_required: bool,
    /// Every selected employee, in id order.
    pub rows: Vec<BulkCorrectionPreviewRow>,
}

#[derive(Debug, Serialize)]
pub struct BulkCorrectionResultRow {
    pub employee_id: Uuid,
    pub outcome: &'static str,
    /// Fields written now.
    pub applied: Vec<String>,
    /// PENDING: the BW-17 request the second person decides.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_request_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'static str>,
}

#[derive(Debug, Serialize)]
pub struct BulkCorrectionResult {
    pub bulk_correction_id: Uuid,
    pub counts: BulkCorrectionCounts,
    pub review_required: bool,
    pub rows: Vec<BulkCorrectionResultRow>,
}

/// `GET /employees/corrections/bulk/{id}`: the recorded job. Field names and
/// counts only; the values are in the ledger rows that name this job.
#[derive(Debug, Serialize)]
pub struct BulkCorrectionJob {
    pub id: Uuid,
    pub fields: Vec<String>,
    pub reason_code: String,
    pub counts: BulkCorrectionCounts,
    pub review_required: bool,
    pub created_by: Uuid,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}
