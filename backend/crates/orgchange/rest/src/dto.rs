use crate::*;

// ---------------------------------------------------------------------------
// Request DTOs
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateOrgChangeRequest {
    pub(crate) kind: OrgChangeKind,
    pub(crate) target: OrgChangeTarget,
    #[serde(with = "iso_date")]
    pub(crate) effective_date: Date,
    pub(crate) reason: String,
    pub(crate) proposal: Vec<OrgProposalOp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) supersedes_id: Option<Uuid>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LegacyCreateRegionRequest {
    pub(crate) name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LegacyUpdateRegionRequest {
    pub(crate) name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LegacyCreateBranchRequest {
    pub(crate) region_id: Uuid,
    pub(crate) name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LegacyUpdateBranchRequest {
    #[serde(default)]
    pub(crate) region_id: Option<Uuid>,
    #[serde(default)]
    pub(crate) name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateOrgUnitRequest {
    pub(crate) kind: OrgUnitKind,
    /// Required for DEPARTMENT/TEAM; null or the Company root id for SITE.
    #[serde(default)]
    pub(crate) parent_id: Option<Uuid>,
    pub(crate) name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateOrgUnitRequest {
    #[serde(default)]
    pub(crate) name: Option<String>,
    #[serde(default)]
    pub(crate) parent_id: Option<Uuid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateOrgChangeDraftRequest {
    #[serde(default)]
    pub(crate) kind: Option<OrgChangeKind>,
    #[serde(default, with = "iso_date::option")]
    pub(crate) effective_date: Option<Date>,
    #[serde(default)]
    pub(crate) reason: Option<String>,
    #[serde(default)]
    pub(crate) proposal: Option<Vec<OrgProposalOp>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum WireDecision {
    Approved,
    Rejected,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OrgChangeDecisionRequest {
    pub(crate) decision: WireDecision,
    #[serde(default)]
    pub(crate) memo: Option<String>,
    #[serde(default, rename = "expected_version")]
    pub(crate) expected_version: Option<String>,
    #[serde(default, rename = "through_step")]
    pub(crate) through_step: Option<Uuid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CompleteSettlementItemRequest {
    #[serde(default)]
    pub(crate) memo: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CancelOrgChangeRequest {
    pub(crate) reason: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ListQuery {
    #[serde(default, rename = "target_ref")]
    pub(crate) target_ref: Option<String>,
    /// One status or a comma-separated list (`status=DRAFT,IN_APPROVAL`).
    #[serde(default)]
    pub(crate) status: Option<String>,
    #[serde(default)]
    pub(crate) kind: Option<String>,
    #[serde(default, rename = "drafted_by")]
    pub(crate) drafted_by: Option<Uuid>,
    #[serde(default, rename = "effective_from")]
    pub(crate) effective_from: Option<String>,
    #[serde(default, rename = "effective_to")]
    pub(crate) effective_to: Option<String>,
    #[serde(default)]
    pub(crate) limit: Option<i64>,
    #[serde(default)]
    pub(crate) offset: Option<i64>,
}
