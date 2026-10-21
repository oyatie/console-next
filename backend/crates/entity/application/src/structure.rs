//! 회사 구조 labels (decisions #18, #21; structure-ux review R15, R16): the
//! 사업장 code and the sibling order of 법인, 사업장 and 부서. Labels are changed
//! in place in both phases and audited, never dated.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Set (or clear, `null`) the code of one 사업장.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetWorkplaceCode {
    pub code: Option<String>,
}

/// Whose children are reordered: at most one of the three; none names the
/// tenant, whose children are its 법인.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StructureParent {
    /// The 사업장 of this 법인.
    pub legal_entity_id: Option<Uuid>,
    /// The 부서 directly in this 사업장.
    pub workplace_id: Option<Uuid>,
    /// The 부서 under this 부서.
    pub org_unit_id: Option<Uuid>,
}

/// The full new order of one parent's children: every current child, once.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReorderStructure {
    #[serde(flatten)]
    pub parent: StructureParent,
    pub children: Vec<Uuid>,
    /// The order the caller read (the precondition): when given and the
    /// order changed since, 409 `children_changed` — no lost reorder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_children: Option<Vec<Uuid>>,
}

/// The order a reorder left.
#[derive(Debug, Clone, Serialize)]
pub struct StructureOrder {
    pub children: Vec<Uuid>,
    pub change_mode: String,
}
