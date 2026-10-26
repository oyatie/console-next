use crate::*;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrgChangeTarget {
    pub kind: TargetKind,
    #[serde(rename = "ref")]
    pub target_ref: String,
    pub label: String,
}

impl OrgChangeTarget {
    pub fn validate(&self) -> Result<(), KernelError> {
        bounded(&self.target_ref, "target.ref", 200)?;
        bounded(&self.label, "target.label", 200)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightBlocker {
    pub code: String,
    pub label: String,
    pub dependent_kind: String,
    pub count: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightWarning {
    pub code: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dependent_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightReport {
    #[serde(with = "time::serde::rfc3339")]
    pub computed_at: OffsetDateTime,
    /// True when the draft was edited after this receipt was computed.
    pub stale: bool,
    pub blockers: Vec<PreflightBlocker>,
    pub warnings: Vec<PreflightWarning>,
    pub headcount: i64,
    pub dependents_total: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgChangeSummary {
    pub id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_id: Option<Uuid>,
    /// Server-issued display code `OC-YYYY-NNNN`.
    pub code: String,
    pub kind: OrgChangeKind,
    pub status: OrgChangeStatus,
    pub target: OrgChangeTarget,
    #[serde(with = "iso_date")]
    pub effective_date: Date,
    #[serde(
        rename = "applies_at",
        with = "time::serde::rfc3339::option",
        skip_serializing_if = "Option::is_none"
    )]
    pub applies_at: Option<OffsetDateTime>,
    /// Canonical create command results, available after the proposal applies.
    #[serde(rename = "created_unit_ids", skip_serializing_if = "Option::is_none")]
    pub created_unit_ids: Option<Vec<Uuid>>,
    pub reason: String,
    pub headcount: i64,
    pub site_count: i64,
    pub team_count: i64,
    pub drafted_by: Uuid,
    /// The drafter's display name within the tenant; null when unknown.
    pub drafted_by_name: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supersedes_id: Option<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalStepView {
    pub id: Uuid,
    pub step_order: i16,
    pub role_key: ApprovalRoleKey,
    pub decision: StepDecision,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decided_by: Option<Uuid>,
    /// The decider's display name within the tenant; null when undecided or unknown.
    pub decided_by_name: Option<String>,
    #[serde(
        with = "time::serde::rfc3339::option",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub decided_at: Option<OffsetDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memo: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettlementItemView {
    pub id: Uuid,
    pub item_key: SettlementKey,
    pub label: String,
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done_by: Option<Uuid>,
    /// The completer's display name within the tenant; null when open or unknown.
    pub done_by_name: Option<String>,
    #[serde(
        with = "time::serde::rfc3339::option",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub done_at: Option<OffsetDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memo: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgChangeEventView {
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
    pub actor: Uuid,
    /// The actor's display name within the tenant; null when unknown.
    pub actor_name: Option<String>,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgChangeDetail {
    #[serde(flatten)]
    pub summary: OrgChangeSummary,
    pub proposal: Vec<OrgProposalOp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preflight: Option<PreflightReport>,
    pub approval_steps: Vec<ApprovalStepView>,
    pub settlement_items: Vec<SettlementItemView>,
    pub events: Vec<OrgChangeEventView>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgChangePage {
    pub items: Vec<OrgChangeSummary>,
    pub total: i64,
}

/// How a legacy org-structure row resolves onto a canonical Company/OrgUnit id.
///
/// `Ambiguous` is reserved for name/text resolution attempts: it MUST NOT be
/// treated as authority to mint a binding (L5-ORG / handoff P5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CanonicalResolutionStatus {
    Resolved,
    Unbound,
    Ambiguous,
}

/// One legacy region/branch (or already-bound source) projected onto OrgUnit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgUnitReference {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_unit_id: Option<Uuid>,
    pub source_kind: String,
    pub source_id: String,
    pub resolution_status: CanonicalResolutionStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgEntitySummary {
    pub org_id: Uuid,
    pub slug: String,
    pub name: String,
    pub status: String,
    /// Tenant identity IS the Company (`organizations.id`); never a parallel
    /// `/companies` id space.
    pub company_id: Uuid,
    pub company_resolution_status: CanonicalResolutionStatus,
    /// Region/branch → OrgUnit projections for this tenant (unbound rows stay
    /// visible with `orgUnitId: null` so clients can see gaps deny-by-field).
    pub org_units: Vec<OrgUnitReference>,
}

// ---------------------------------------------------------------------------
// OrgUnit read model (GET /api/v1/org-units)
// ---------------------------------------------------------------------------

/// Wire kind of an org-tree node: the Company root plus the OrgUnit kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OrgTreeNodeKind {
    Company,
    Site,
    Department,
}

impl From<OrgUnitKind> for OrgTreeNodeKind {
    fn from(kind: OrgUnitKind) -> Self {
        match kind {
            OrgUnitKind::Site => Self::Site,
            OrgUnitKind::Department => Self::Department,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OrgUnitStatus {
    Active,
    Dissolved,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgUnitHeadView {
    pub id: Uuid,
    pub kind: OrgTreeNodeKind,
    pub name: String,
    pub parent_id: Option<Uuid>,
    pub status: OrgUnitStatus,
    #[serde(with = "iso_date")]
    pub effective_from: Date,
    /// ACTIVE employees bound to this unit (not rolled up from children).
    pub headcount: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgUnitListView {
    /// The Company root first, then every Site/Department head.
    pub items: Vec<OrgUnitHeadView>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgUnitRevisionView {
    pub version: i64,
    pub name: String,
    pub parent_id: Option<Uuid>,
    pub status: OrgUnitStatus,
    #[serde(with = "iso_date")]
    pub effective_from: Date,
    pub actor_id: Uuid,
    /// The actor's display name within the tenant; null when unknown.
    pub actor_name: Option<String>,
    pub actor_kind: Option<String>,
    pub command_id: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    /// The unit's code in this revision (UX-R2 org-17: a code change is a history line).
    pub code: Option<String>,
    /// The 부서장 in this revision, and their name (a head change is a history line).
    pub head_employee_id: Option<Uuid>,
    pub head_name: Option<String>,
    /// The unit a dissolved one was merged into (합치기, org-07).
    pub merged_into: Option<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgUnitMemberView {
    pub employee_id: Uuid,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub employee_number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(with = "iso_date::option", skip_serializing_if = "Option::is_none")]
    pub since: Option<Date>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgUnitMembersView {
    pub headcount: i64,
    /// Active members, name order, capped at 200.
    pub items: Vec<OrgUnitMemberView>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgUnitDetailView {
    #[serde(flatten)]
    pub head: OrgUnitHeadView,
    /// Newest first.
    pub revisions: Vec<OrgUnitRevisionView>,
    pub members: OrgUnitMembersView,
}
