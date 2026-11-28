// SPDX-License-Identifier: LicenseRef-Proprietary
use super::RestError;
use console_platform_authz::{
    Action, Feature, Principal, authorize_capability, authorize_org_wide,
};

/// Cycles and ledgers have no branch boundary. Only personal tasks and submissions
/// have an independently enforced subject/manager relationship.
pub(super) fn require_feature(principal: &Principal, feature: Feature) -> Result<(), RestError> {
    let action = Action::new(feature);
    if feature == Feature::EvaluationSubmit {
        authorize_capability(principal, action)
    } else {
        authorize_org_wide(principal, action)
    }
    .map_err(RestError::from_kernel)
}

pub(super) fn holds_feature(principal: &Principal, feature: Feature) -> bool {
    require_feature(principal, feature).is_ok()
}
