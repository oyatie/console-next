use std::collections::BTreeSet;

use console_kernel_core::{AccessScope, BranchId, BranchScope, OrgId, ServicePrincipalId, UserId};

use crate::access::ScopeGrant;
use crate::{DatedFeatureGrant, EffectiveFeatureGrant, Feature, Role, SubjectFreshness};

/// Live session authority; no tenant roles or account grants are attached.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SupportPrincipal {
    pub session_id: uuid::Uuid,
    pub operator_label: String,
    pub scope: Vec<String>,
    pub reveal_classes: Vec<String>,
}

/// Authenticated principal plus its already-resolved branch scope.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Principal {
    #[serde(default)]
    pub support: Option<SupportPrincipal>,
    pub user_id: UserId,
    /// The tenant this principal belongs to, taken from the verified token's
    /// `org` claim. Used to arm `app.current_org` for RLS on this request.
    pub org_id: OrgId,
    pub access_scope: AccessScope,
    pub roles: BTreeSet<Role>,
    pub branch_scope: BranchScope,
    /// Runtime-effective grants resolved from active tenant-owned custom roles.
    ///
    /// These are additive to the built-in role matrix and never widen
    /// [`Self::branch_scope`]. Resolver failures fail closed before a request
    /// principal is built; unsupported ABAC/PBAC conditions are omitted rather
    /// than guessed.
    pub effective_feature_grants: Vec<EffectiveFeatureGrant>,
    /// Grants that carry an effective-dated interval (ADR-0032 §1).
    ///
    /// They are a SEPARATE field from [`Self::effective_feature_grants`] on
    /// purpose. Every reader of that field — including the REST list gates in
    /// crates this one does not own — is time-blind: it is given no decision
    /// instant and cannot acquire one. Keeping dated grants out of it is what
    /// makes "an expired grant authorizes nothing" a property of the types
    /// rather than of every reader remembering a filter. The only way to get an
    /// [`EffectiveFeatureGrant`] out of one is
    /// [`DatedFeatureGrant::resolve`], which demands the instant.
    #[serde(default)]
    pub dated_feature_grants: Vec<DatedFeatureGrant>,
    /// Subject authorization freshness carried by the verified access token
    /// (Cedar/PBAC activation, ADR-0021). Set from the token's mint-time snapshot
    /// claims by `resolve_principal_from_bearer_token`.
    ///
    /// SLICE-2 only SOURCES this; no live authorization decision consults it and
    /// the Cedar path stays unreachable. It defaults to the no-material baseline
    /// (all zero), so a token minted before the freshness claims existed yields
    /// [`SubjectFreshness::default`] and every current live path is unchanged.
    #[serde(default)]
    pub authz_freshness: SubjectFreshness,
    /// The tenant's one ops account (break-glass, decision #26). Every request
    /// it makes is logged at resolution; it is never a grant target.
    #[serde(default)]
    pub is_tenant_ops: bool,
    /// AX-5: every (operation key, scope node) the account's grants that
    /// count now hold, each decided by Cedar on the grant's own node. The
    /// doors that decide per resource read this, never the branch projection.
    #[serde(default)]
    pub scope_grants: Vec<ScopeGrant>,
}

/// A machine identity resolved from the production-service-principal resolver.
/// It intentionally has no roles or effective human grants.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServicePrincipal {
    pub id: ServicePrincipalId,
    pub org_id: OrgId,
    pub branch_id: BranchId,
    pub feature: Feature,
}

impl ServicePrincipal {
    #[must_use]
    pub const fn new(
        id: ServicePrincipalId,
        org_id: OrgId,
        branch_id: BranchId,
        feature: Feature,
    ) -> Self {
        Self {
            id,
            org_id,
            branch_id,
            feature,
        }
    }
}

impl Principal {
    #[must_use]
    pub const fn new(
        user_id: UserId,
        org_id: OrgId,
        roles: BTreeSet<Role>,
        branch_scope: BranchScope,
    ) -> Self {
        Self {
            support: None,
            user_id,
            org_id,
            access_scope: AccessScope::legacy_org(org_id),
            roles,
            branch_scope,
            effective_feature_grants: Vec::new(),
            dated_feature_grants: Vec::new(),
            authz_freshness: SubjectFreshness {
                policy_version: 0,
                subject_version: 0,
                session_generation: 0,
                step_up_generation: None,
            },
            is_tenant_ops: false,
            scope_grants: Vec::new(),
        }
    }

    #[must_use]
    pub const fn with_access_scope(mut self, access_scope: AccessScope) -> Self {
        self.access_scope = access_scope;
        self
    }

    /// Attach the subject authorization freshness snapshot carried by the
    /// verified token (Cedar/PBAC activation). SLICE-2 only sources it; no live
    /// decision consults it yet.
    #[must_use]
    pub const fn with_authz_freshness(mut self, freshness: SubjectFreshness) -> Self {
        self.authz_freshness = freshness;
        self
    }

    #[must_use]
    pub const fn with_tenant_ops(mut self, is_tenant_ops: bool) -> Self {
        self.is_tenant_ops = is_tenant_ops;
        self
    }

    #[must_use]
    pub fn with_effective_feature_grants(mut self, grants: Vec<EffectiveFeatureGrant>) -> Self {
        self.effective_feature_grants = grants;
        self
    }

    #[must_use]
    pub fn with_scope_grants(mut self, grants: Vec<ScopeGrant>) -> Self {
        self.scope_grants = grants;
        self
    }

    /// The scope nodes the account holds `feature` over (AX-5).
    pub fn scopes_for(&self, feature: Feature) -> impl Iterator<Item = &ScopeGrant> {
        self.scope_grants
            .iter()
            .filter(move |g| g.feature == feature)
    }

    /// Attach grants that carry an effective-dated interval. Only
    /// [`authorize_scoped`], which is given the decision instant, can see them.
    ///
    /// [`authorize_scoped`]: crate::authorize_scoped
    #[must_use]
    pub fn with_dated_feature_grants(mut self, grants: Vec<DatedFeatureGrant>) -> Self {
        self.dated_feature_grants = grants;
        self
    }
}
