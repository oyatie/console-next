use std::collections::BTreeSet;

use console_kernel_core::{BranchId, OrgId};

use crate::{Action, Principal};

/// Mutable subject/version inputs that make stale subject material deny.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubjectFreshness {
    pub policy_version: u64,
    pub subject_version: u64,
    pub session_generation: u64,
    pub step_up_generation: Option<u64>,
}

impl SubjectFreshness {
    #[must_use]
    pub const fn has_subject_material(self) -> bool {
        self.policy_version > 0
            || self.subject_version > 0
            || self.session_generation > 0
            || self.step_up_generation.is_some()
    }

    #[must_use]
    pub const fn satisfies(self, required: SubjectFreshnessRequirement) -> bool {
        self.policy_version >= required.min_policy_version
            && self.subject_version >= required.min_subject_version
            && self.session_generation >= required.min_session_generation
            && match required.required_step_up_generation {
                Some(required_step_up) => match self.step_up_generation {
                    Some(actual_step_up) => actual_step_up >= required_step_up,
                    None => false,
                },
                None => true,
            }
    }
}

/// Minimum freshness the authorization boundary requires for this request.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubjectFreshnessRequirement {
    pub min_policy_version: u64,
    pub min_subject_version: u64,
    pub min_session_generation: u64,
    pub required_step_up_generation: Option<u64>,
}

impl SubjectFreshnessRequirement {
    #[must_use]
    pub const fn requires_subject_material(self) -> bool {
        self.min_policy_version > 0
            || self.min_subject_version > 0
            || self.min_session_generation > 0
            || self.required_step_up_generation.is_some()
    }
}

/// Server-loaded subject for a Cedar/PBAC authorization request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizationSubject {
    pub principal: Principal,
    pub freshness: SubjectFreshness,
    /// Server-loaded clearance labels for Cedar-only high-sensitivity actions.
    /// Empty means deny-by-omission when a bundle requires a clearance key.
    pub clearance_keys: BTreeSet<String>,
}

impl AuthorizationSubject {
    #[must_use]
    pub fn new(principal: Principal, freshness: SubjectFreshness) -> Self {
        Self {
            principal,
            freshness,
            clearance_keys: BTreeSet::new(),
        }
    }
}

/// Server-loaded resource scope for authorization.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizationResource {
    pub org_id: OrgId,
    pub branch_id: Option<BranchId>,
    pub resource_type: String,
    pub resource_id: Option<String>,
    /// Distinguishes the two reasons `branch_id` can be `None`: the resource has
    /// NO branch at all (`true` → [`authorize_capability`]) versus the action
    /// spans EVERY branch (`false` → [`authorize_org_wide`]). Private so the
    /// three constructors stay the only way to build this; `serde(default)`
    /// keeps every historical audit payload deserializing onto the org-wide arm,
    /// which is what they were decided under.
    ///
    /// [`authorize_capability`]: crate::authorize_capability
    /// [`authorize_org_wide`]: crate::authorize_org_wide
    #[serde(default)]
    pub(super) branchless: bool,
}

impl AuthorizationResource {
    #[must_use]
    pub fn branch(org_id: OrgId, branch_id: BranchId, resource_type: impl Into<String>) -> Self {
        Self {
            org_id,
            branch_id: Some(branch_id),
            resource_type: resource_type.into(),
            resource_id: None,
            branchless: false,
        }
    }

    /// A resource with no branch dimension at all — a workflow run, a workflow
    /// definition, a row in a table with no `branch_id` column. Decided by
    /// [`authorize_capability`]: the matrix cell without the branch check, NOT
    /// [`authorize_org_wide`]'s all-branch/SUPER_ADMIN-or-EXECUTIVE gate.
    ///
    /// [`authorize_capability`]: crate::authorize_capability
    /// [`authorize_org_wide`]: crate::authorize_org_wide
    #[must_use]
    pub fn branchless(org_id: OrgId, resource_type: impl Into<String>) -> Self {
        Self {
            org_id,
            branch_id: None,
            resource_type: resource_type.into(),
            resource_id: None,
            branchless: true,
        }
    }

    /// An action that spans every branch in the org. Decided by
    /// [`authorize_org_wide`] — see [`Self::branchless`] for the other reason a
    /// request can carry no branch.
    ///
    /// [`authorize_org_wide`]: crate::authorize_org_wide
    #[must_use]
    pub fn org_wide(org_id: OrgId, resource_type: impl Into<String>) -> Self {
        Self {
            org_id,
            branch_id: None,
            resource_type: resource_type.into(),
            resource_id: None,
            branchless: false,
        }
    }

    #[must_use]
    pub fn with_resource_id(mut self, resource_id: impl Into<String>) -> Self {
        self.resource_id = Some(resource_id.into());
        self
    }
}

/// Non-authoritative context attributes supplied by the server boundary.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizationContext {
    pub purpose: Option<String>,
    pub channel: Option<String>,
    pub request_id: Option<String>,
}

/// Evidence that DB reads used to build the Cedar request were performed under
/// an armed Postgres RLS scope. This is a typed witness for the cutover contract:
/// Cedar may decide capabilities/actions, but it never replaces `console_rt`/RLS row
/// isolation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RlsScopeProofSource {
    RuntimeRoleGuc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RlsScopeProof {
    pub org_id: OrgId,
    pub source: RlsScopeProofSource,
}

impl RlsScopeProof {
    #[must_use]
    pub const fn runtime_role_guc(org_id: OrgId) -> Self {
        Self {
            org_id,
            source: RlsScopeProofSource::RuntimeRoleGuc,
        }
    }
}

/// Typed authorization request used by both the legacy adapter and later Cedar
/// adapter. The server constructs this from verified token + DB-loaded facts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizationRequest {
    pub subject: AuthorizationSubject,
    pub action: Action,
    pub domain: String,
    pub resource: AuthorizationResource,
    pub context: AuthorizationContext,
    pub required_freshness: SubjectFreshnessRequirement,
    pub rls_scope_proof: Option<RlsScopeProof>,
}

impl AuthorizationRequest {
    #[must_use]
    pub fn new(principal: Principal, action: Action, resource: AuthorizationResource) -> Self {
        Self {
            subject: AuthorizationSubject::new(principal, SubjectFreshness::default()),
            action,
            domain: String::new(),
            resource,
            context: AuthorizationContext::default(),
            required_freshness: SubjectFreshnessRequirement::default(),
            rls_scope_proof: None,
        }
    }

    #[must_use]
    pub fn with_policy_domain(mut self, domain: impl Into<String>) -> Self {
        self.domain = domain.into();
        self
    }

    #[must_use]
    pub fn with_subject_freshness(mut self, freshness: SubjectFreshness) -> Self {
        self.subject.freshness = freshness;
        self
    }

    #[must_use]
    pub fn with_clearance_keys(mut self, clearance_keys: BTreeSet<String>) -> Self {
        self.subject.clearance_keys = clearance_keys;
        self
    }

    #[must_use]
    pub fn requiring_freshness(mut self, required: SubjectFreshnessRequirement) -> Self {
        self.required_freshness = required;
        self
    }

    #[must_use]
    pub fn with_rls_scope_proof(mut self, proof: RlsScopeProof) -> Self {
        self.rls_scope_proof = Some(proof);
        self
    }
}
