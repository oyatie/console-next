//! Setup-phase 부서 batches (MR-12, decisions #18 and #20): create, rename,
//! move and dissolve 부서 in one transaction, each change pinned to the
//! version the client read, every batch undoable until 운영 시작.
//!
//! There is one 부서 kind: the level is never asked. A 부서 created with a
//! `workplace_id` sits directly in that 사업장; with a parent (an existing
//! unit, or the `ref` of a unit created earlier in the same batch) it sits
//! under that 부서 or 사업장 unit.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Where a created or moved 부서 goes: exactly one of the three.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrgParent {
    /// Directly in this 사업장 (its own unit).
    pub workplace_id: Option<Uuid>,
    /// Under this existing unit (a 부서, or a 사업장's own unit).
    pub parent_org_unit_id: Option<Uuid>,
    /// Under the unit created earlier in this batch with this `ref`.
    pub parent_ref: Option<String>,
}

/// One change in a batch. Fields are optional on the wire so a missing one
/// is a 422 with a field pointer (`ops[2].expected_version`), not a parse error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OrgSetupOp {
    Create {
        /// A client label later ops of the same batch can name as `parent_ref`.
        #[serde(rename = "ref")]
        client_ref: Option<String>,
        name: Option<String>,
        #[serde(flatten)]
        parent: OrgParent,
        /// 부서 코드 (G5): `[A-Za-z0-9_-]` ≤ 20, unique among active 부서.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        /// 부서장 (D19): someone who has not left; may sit outside the unit.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        head_employee_id: Option<Uuid>,
    },
    Rename {
        org_unit_id: Option<Uuid>,
        expected_version: Option<i32>,
        name: Option<String>,
    },
    Move {
        org_unit_id: Option<Uuid>,
        expected_version: Option<i32>,
        #[serde(flatten)]
        parent: OrgParent,
    },
    /// Dissolve the 부서 and the 부서 under it. Refused while anyone who has
    /// not left is placed in any of them.
    Dissolve {
        org_unit_id: Option<Uuid>,
        expected_version: Option<i32>,
    },
    /// 부서 코드 and 부서장 (G5, D19), both the full new values (`null`
    /// clears). The attribute keys are the ones the org change's
    /// `SET_ORG_UNIT_DETAILS` writes, so one read serves both phases.
    SetDetails {
        org_unit_id: Option<Uuid>,
        expected_version: Option<i32>,
        code: Option<String>,
        head_employee_id: Option<Uuid>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrgSetupBatch {
    pub ops: Vec<OrgSetupOp>,
}

/// One unit a batch (or its undo) changed, and the version it left it at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrgSetupUnit {
    pub op_index: usize,
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub client_ref: Option<String>,
    pub org_unit_id: Uuid,
    pub version: i64,
}

/// What a batch did: the receipt its 「되돌리기」 names.
#[derive(Debug, Clone, Serialize)]
pub struct OrgSetupReceipt {
    pub batch_id: Uuid,
    pub change_mode: String,
    pub units: Vec<OrgSetupUnit>,
}

/// A row of 「설정 단계 기록」 for 부서: one batch or undo.
#[derive(Debug, Clone, Serialize)]
pub struct OrgSetupBatchView {
    pub id: Uuid,
    /// `APPLY` or `UNDO`.
    pub kind: String,
    pub undoes: Option<Uuid>,
    pub undone_by: Option<Uuid>,
    /// An APPLY not yet undone, while the tenant is in setup.
    pub undoable: bool,
    pub units: Vec<OrgSetupUnit>,
    pub actor_id: Uuid,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: time::OffsetDateTime,
}
