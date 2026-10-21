use super::*;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CreateDraftBody {
    pub(super) draft_key: String,
    pub(super) title: String,
    #[serde(default)]
    pub(super) author_note: Option<String>,
    pub(super) blocks: NoCodeBlocks,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct UpdateDraftBody {
    #[serde(default)]
    pub(super) title: Option<String>,
    #[serde(default)]
    pub(super) author_note: Option<String>,
    pub(super) blocks: NoCodeBlocks,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ReviewBody {
    pub(super) decision: ReviewDecision,
    #[serde(default)]
    pub(super) note: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SimulateBody {
    pub(super) request: SimRequest,
    /// Optional what-if: include this draft's generated policy text on top of the
    /// enforced set (the "what if I promote this draft" preview).
    #[serde(default)]
    pub(super) include_draft_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct AuthorizeBody {
    pub(super) request: SimRequest,
    /// Scope the live decision to the policies attached to one object type (row
    /// policy) or property (field policy). Absent ⇒ the org's enforced set.
    #[serde(default)]
    pub(super) object_type_id: Option<Uuid>,
    #[serde(default)]
    pub(super) property_def_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct BulkAuthorizeBody {
    pub(super) subject: SimSubject,
    pub(super) checks: Vec<BulkCheck>,
}
