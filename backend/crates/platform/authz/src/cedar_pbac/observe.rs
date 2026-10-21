use console_kernel_core::{BranchId, OrgId};

use super::{
    AuthorizationDecision, AuthorizationRequest, CedarEvaluation, CoexistenceMapEntry,
    CompiledBundleCacheKey, DecisionEffect, DecisionEngine, DecisionReason, DualEngineMode,
    RlsScopeProof, SubjectFreshness, SubjectFreshnessRequirement,
};
use crate::PermissionLevel;

/// Low-cardinality labels for the Cedar/PBAC authorization metric.
///
/// Version and digest material intentionally stays on the audit event instead
/// of metric labels. That keeps the metric safe to emit on every decision while
/// the audit event carries the full forensic trail for stale-policy and
/// stale-subject investigations.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizationMetricLabels {
    pub effect: DecisionEffect,
    pub engine: DecisionEngine,
    pub reason: DecisionReason,
    pub mode: Option<DualEngineMode>,
    pub domain: Option<String>,
}

/// Audit payload emitted with every Cedar/PBAC boundary decision.
///
/// This is a contract shape, not a live event sink. Later slices can hand this
/// to the existing audit writer after arming the request's RLS context. The
/// values are all server-derived so UI/JWT projections cannot fabricate an
/// authorization decision.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizationAuditEvent {
    pub decision: AuthorizationDecision,
    pub coexistence_entry_id: Option<String>,
    pub domain: Option<String>,
    pub request_domain: String,
    pub action: String,
    pub required_permission: String,
    pub resource_type: String,
    pub resource_id: Option<String>,
    pub principal_org_id: OrgId,
    pub resource_org_id: OrgId,
    pub branch_id: Option<BranchId>,
    pub request_id: Option<String>,
    pub purpose: Option<String>,
    pub channel: Option<String>,
    pub subject_freshness: SubjectFreshness,
    pub required_freshness: SubjectFreshnessRequirement,
    pub rls_scope_proof: Option<RlsScopeProof>,
    /// Expected bundle identity from the coexistence map.
    pub bundle_key: Option<CompiledBundleCacheKey>,
    /// Actual bundle identity reported by Cedar evaluation, when Cedar returned
    /// a bundle-bearing result. This makes stale-policy investigations compare
    /// expected vs evaluated digests instead of losing the stale identity.
    pub evaluated_bundle_key: Option<CompiledBundleCacheKey>,
    /// Raw human-readable Cedar adapter denial/error text. The machine-readable
    /// `decision.reason` remains the stable audit/metric dimension; this detail
    /// preserves forensic context for triage without becoming a metric label.
    pub evaluated_reason_detail: Option<String>,
}

impl AuthorizationAuditEvent {
    #[must_use]
    pub fn metric_labels(&self) -> AuthorizationMetricLabels {
        AuthorizationMetricLabels {
            effect: self.decision.effect,
            engine: self.decision.engine,
            reason: self.decision.reason,
            mode: self.decision.mode,
            domain: self.domain.clone(),
        }
    }
}

/// Build the auditable/metric-ready observation for a boundary decision.
///
/// The caller supplies the already-computed decision so observation cannot
/// mutate enforcement. Missing map entries still produce an event with no
/// bundle key/domain, proving the failure was fail-closed rather than hidden.
#[must_use]
pub fn observe_cedar_pbac_decision(
    request: &AuthorizationRequest,
    map_entry: Option<&CoexistenceMapEntry>,
    cedar: Option<&CedarEvaluation>,
    decision: AuthorizationDecision,
) -> AuthorizationAuditEvent {
    AuthorizationAuditEvent {
        decision,
        coexistence_entry_id: map_entry.map(|entry| entry.id.clone()),
        domain: map_entry.map(|entry| entry.domain.clone()),
        request_domain: request.domain.clone(),
        action: request.action.feature().as_str().to_owned(),
        required_permission: permission_level_code(request.action.required_permission()).to_owned(),
        resource_type: request.resource.resource_type.clone(),
        resource_id: request.resource.resource_id.clone(),
        principal_org_id: request.subject.principal.org_id,
        resource_org_id: request.resource.org_id,
        branch_id: request.resource.branch_id,
        request_id: request.context.request_id.clone(),
        purpose: request.context.purpose.clone(),
        channel: request.context.channel.clone(),
        subject_freshness: request.subject.freshness,
        required_freshness: request.required_freshness,
        rls_scope_proof: request.rls_scope_proof,
        bundle_key: map_entry.and_then(|entry| entry.bundle_key.clone()),
        evaluated_bundle_key: cedar.and_then(cedar_evaluation_bundle_key),
        evaluated_reason_detail: cedar.and_then(cedar_evaluation_reason_detail),
    }
}

fn cedar_evaluation_bundle_key(cedar: &CedarEvaluation) -> Option<CompiledBundleCacheKey> {
    match cedar {
        CedarEvaluation::Allow { bundle_key } | CedarEvaluation::Deny { bundle_key, .. } => {
            Some(bundle_key.clone())
        }
        CedarEvaluation::Error { .. } | CedarEvaluation::NotConfigured => None,
    }
}

fn cedar_evaluation_reason_detail(cedar: &CedarEvaluation) -> Option<String> {
    match cedar {
        CedarEvaluation::Deny { reason, .. } | CedarEvaluation::Error { reason } => {
            Some(reason.clone())
        }
        CedarEvaluation::Allow { .. } | CedarEvaluation::NotConfigured => None,
    }
}

const fn permission_level_code(permission: PermissionLevel) -> &'static str {
    match permission {
        PermissionLevel::Deny => "deny",
        PermissionLevel::RequestOnly => "request_only",
        PermissionLevel::Limited => "limited",
        PermissionLevel::Allow => "allow",
    }
}
