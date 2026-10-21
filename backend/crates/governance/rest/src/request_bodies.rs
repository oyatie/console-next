use super::*;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct DecideApprovalRequest {
    pub(super) request_ref: Uuid,
    pub(super) kind: String,
    /// Deprecated. Still accepted on the wire (the published OpenAPI contract
    /// carries it) but IGNORED as authority: the requester is read from the open
    /// pending request row inside the decision transaction, so a client cannot
    /// name the person the approver is supposedly distinct from.
    #[allow(dead_code)]
    pub(super) requested_by: Uuid,
    pub(super) decision: ApprovalDecisionRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ApprovalDecisionRequest {
    Approved,
    Rejected,
}

impl From<ApprovalDecisionRequest> for ApprovalDecision {
    fn from(value: ApprovalDecisionRequest) -> Self {
        match value {
            ApprovalDecisionRequest::Approved => Self::Approved,
            ApprovalDecisionRequest::Rejected => Self::Rejected,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ConfigureTransitionRequest {
    pub(super) object_type_id: Uuid,
    pub(super) from_state: LifecycleState,
    pub(super) to_state: LifecycleState,
    #[serde(default)]
    pub(super) requires_reason: bool,
    #[serde(default)]
    pub(super) requires_four_eyes: bool,
    #[serde(default)]
    pub(super) requires_checklist: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PreflightRequest {
    pub(super) object_type_id: Uuid,
    pub(super) from_state: LifecycleState,
    pub(super) to_state: LifecycleState,
    /// Cedar authorize effect for the Authority gate (the console already has a
    /// decision; the writeback lane re-runs Cedar itself). Absent ⇒ fail-closed.
    #[serde(default)]
    pub(super) authority_allow: Option<bool>,
    #[serde(default)]
    pub(super) checklist_all_acknowledged: Option<bool>,
    /// Four-eyes request ref; its decision is read from the DB, not trusted from
    /// the client.
    #[serde(default)]
    pub(super) four_eyes_request_ref: Option<Uuid>,
    #[serde(default)]
    pub(super) egress_cleared: Option<bool>,
}
