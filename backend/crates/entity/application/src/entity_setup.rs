//! Bulk 법인 · 사업장 create and update (MR-29): the sheet import's batch.
//!
//! The browser parses the sheet, maps its columns and merges a partial row
//! over the record it read (`GET /legal-entities`), so every op carries a full
//! state, exactly what the one-by-one create and revise take. The server runs
//! the same writers for every op in ONE transaction: a dry run rolls back and
//! returns per-op outcomes with a field diff and a digest; the apply must
//! carry that digest (onboarding-and-migration §4.2 step 6–7, C12).

use console_entity_domain::legal_entity::LegalEntityInput;
use console_entity_domain::workplace::WorkplaceInput;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

/// One sheet row, as an op.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EntitySetupOp {
    /// The client's row key (`법인!7`), echoed back; another op's
    /// `entity_ref` may name it. Unique within the batch.
    #[serde(rename = "ref")]
    pub reference: Option<String>,
    /// `CREATE_ENTITY` | `REVISE_ENTITY` | `CREATE_WORKPLACE` | `REVISE_WORKPLACE`.
    pub op: Option<String>,
    /// The record a REVISE op changes.
    pub id: Option<Uuid>,
    /// REVISE: the version the client read (409 `stale_revision` otherwise).
    pub expected_version: Option<i32>,
    /// CREATE_WORKPLACE: the 법인, existing ...
    pub legal_entity_id: Option<Uuid>,
    /// ... or created earlier in this batch (its `ref`).
    pub entity_ref: Option<String>,
    /// REVISE: overrides the batch's `effective_from` / `reason_code`.
    pub effective_from: Option<String>,
    pub reason_code: Option<String>,
    /// *_WORKPLACE: make it the 대표 / 본점 사업장 of its 법인.
    pub is_primary: Option<bool>,
    pub is_head_office: Option<bool>,
    /// *_ENTITY: the full state.
    pub entity: Option<LegalEntityInput>,
    /// *_WORKPLACE: the full state.
    pub workplace: Option<WorkplaceInput>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EntitySetupBatch {
    /// `true`: run every op and roll back (writes nothing).
    #[serde(default)]
    pub dry_run: bool,
    /// The apply: the `preview_digest` of the dry run it confirms.
    pub preview_digest: Option<String>,
    /// Defaults for REVISE ops (required on a REVISE without its own).
    pub effective_from: Option<String>,
    pub reason_code: Option<String>,
    #[serde(default)]
    pub ops: Vec<EntitySetupOp>,
}

impl EntitySetupBatch {
    /// What the digest covers: the batch minus the dry-run switches.
    #[must_use]
    pub fn digest_body(&self) -> Value {
        serde_json::json!({
            "effective_from": self.effective_from,
            "reason_code": self.reason_code,
            "ops": self.ops,
        })
    }
}

/// The refusal of one op, as the REST error body would carry it.
#[derive(Debug, Clone, Serialize)]
pub struct OpError {
    pub code: &'static str,
    pub message: String,
    pub fields: Vec<console_entity_domain::refusal::FieldIssue>,
    pub remedy: Option<&'static str>,
    pub current_version: Option<i32>,
    /// `already_exists`: the record the row matched, so the client can turn
    /// the CREATE into a REVISE of it.
    pub existing_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EntitySetupItem {
    pub index: usize,
    #[serde(rename = "ref")]
    pub reference: Option<String>,
    pub op: String,
    /// `CREATED` | `CHANGED` | `UNCHANGED` | `ERROR`.
    pub outcome: &'static str,
    pub target_id: Option<Uuid>,
    /// The version the record is at after the op.
    pub version: Option<i32>,
    /// REVISE: the fields that change, as display text (history's diff).
    pub changes: Vec<crate::FieldChange>,
    pub warnings: Vec<console_entity_domain::refusal::Warning>,
    pub error: Option<OpError>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EntitySetupResult {
    pub dry_run: bool,
    /// Bind the apply to it; a change since → 409 `rows_changed_since_preview`.
    pub preview_digest: String,
    /// The receipt (`None` on a dry run).
    pub batch_id: Option<Uuid>,
    pub change_mode: String,
    pub items: Vec<EntitySetupItem>,
}

/// A receipt in the list (`GET …/setup-batches`).
#[derive(Debug, Clone, Serialize)]
pub struct EntitySetupBatchView {
    pub id: Uuid,
    /// `APPLY` | `UNDO`.
    pub kind: String,
    pub undoes: Option<Uuid>,
    pub undone_by: Option<Uuid>,
    pub change_mode: String,
    pub records: usize,
    pub created_at: String,
    /// SETUP, an APPLY, not undone yet.
    pub undoable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_names: Option<Vec<String>>,
    /// Direct registration receipt from the command ledger; never a batch undo target.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registration_action: Option<String>,
}
