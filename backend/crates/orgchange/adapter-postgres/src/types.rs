use crate::*;

#[derive(Debug, Clone)]
pub struct CreateOrgChange {
    pub kind: OrgChangeKind,
    pub target: OrgChangeTarget,
    pub effective_date: Date,
    pub reason: String,
    pub proposal: Vec<OrgProposalOp>,
    pub supersedes_id: Option<Uuid>,
    pub idempotency_key: String,
    pub fingerprint_input: Value,
}

#[derive(Debug, Clone, Default)]
pub struct DraftPatch {
    pub kind: Option<OrgChangeKind>,
    pub effective_date: Option<Date>,
    pub reason: Option<String>,
    pub proposal: Option<Vec<OrgProposalOp>>,
}

#[derive(Debug, Clone, Default)]
pub struct ListFilter {
    pub effective_from: Option<Date>,
    pub effective_to: Option<Date>,
    /// Any of these statuses; empty means no status filter.
    pub statuses: Vec<OrgChangeStatus>,
    pub drafted_by: Option<Uuid>,
    pub kind: Option<OrgChangeKind>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}
