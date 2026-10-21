use console_kernel_core::{BranchScope, Timestamp};

use crate::{Feature, GrantValidity, PermissionLevel};

/// One runtime-effective custom-role grant after tenant/RLS, status, feature,
/// permission, and supported condition checks have all succeeded.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct EffectiveFeatureGrant {
    pub feature: Feature,
    pub permission: PermissionLevel,
    pub branch_scope: BranchScope,
}

impl EffectiveFeatureGrant {
    #[must_use]
    pub const fn new(
        feature: Feature,
        permission: PermissionLevel,
        branch_scope: BranchScope,
    ) -> Self {
        Self {
            feature,
            permission,
            branch_scope,
        }
    }
}

/// An [`EffectiveFeatureGrant`] that carries an effective-dated interval
/// (ADR-0032 §1) — a 발령 with a start date, and possibly an end date.
///
/// The grant inside is **unreachable without a decision instant**. The field is
/// private and the only way through is [`Self::resolve`], which takes a
/// `Timestamp` and yields nothing outside the interval. That is deliberate and
/// it is the whole design: an interval carried as one more public field beside
/// the others would be an OPT-IN filter, correct only in the readers that
/// remember it, and this crate has readers it does not own — `inventory/rest`,
/// `dispatch/rest` and `identity/rest` all fold over
/// [`Principal::effective_feature_grants`] with no instant in hand and no way to
/// get one. So a dated grant is not in that list at all
/// ([`Principal::dated_feature_grants`] is its own field), and the only thing
/// that can put one there is [`Self::resolve`] having already said yes.
///
/// Forgetting the filter is therefore not possible: there is no filter, and the
/// next reader added inherits the guarantee instead of the default.
///
/// [`Principal::effective_feature_grants`]: crate::Principal::effective_feature_grants
/// [`Principal::dated_feature_grants`]: crate::Principal::dated_feature_grants
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DatedFeatureGrant {
    grant: EffectiveFeatureGrant,
    validity: GrantValidity,
}

impl DatedFeatureGrant {
    #[must_use]
    pub const fn new(grant: EffectiveFeatureGrant, validity: GrantValidity) -> Self {
        Self { grant, validity }
    }

    #[must_use]
    pub const fn validity(&self) -> GrantValidity {
        self.validity
    }

    /// The grant — but only at an instant it is effective at, and only for as
    /// long as the borrow lasts. Re-resolved on every decision, never memoised
    /// (ADR-0032 §3): crossing `valid_from` or `valid_to` is not a write, so no
    /// freshness counter can record it and nothing but re-evaluating this
    /// predicate can notice it (§6).
    #[must_use]
    pub fn resolve(&self, at: Timestamp) -> Option<&EffectiveFeatureGrant> {
        self.validity.contains(at).then_some(&self.grant)
    }
}
