//! Direct department writes require tenant-wide `org_change_apply`.
//! Approval mode `route` refuses before Cedar authorization; no legacy decision is allowed.

use super::super::action_schema::ActionSchema;
use super::super::facts::second_person::ACTOR_HOLDS_PERMISSION;
use crate::Feature;

pub const SCHEMA: ActionSchema = ActionSchema {
    denial_codes: &[],
    feature: Feature::OrgUnitManage,
    version: "2026-10-crud-org-unit-manage-v1",
    facts: &[ACTOR_HOLDS_PERMISSION],
    policies: r#"permit(principal, action == Action::"org_unit_manage", resource)
when {
  principal.org == resource.org &&
  context.actor_holds_permission
};
"#,
};

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use console_kernel_core::{BranchScope, OrgId, UserId};

    use crate::cedar_pbac::action_schema::compile_action_bundle;
    use crate::cedar_pbac::facts::{Facts, evaluate_with_facts};
    use crate::{
        Action, AuthorizationRequest, AuthorizationResource, CedarEvaluation, Feature, Principal,
    };

    fn decide(principal_org: OrgId, resource_org: OrgId, facts: &Facts) -> bool {
        let principal = Principal::new(
            UserId::new(),
            principal_org,
            Default::default(),
            BranchScope::All,
        );
        let bundle = compile_action_bundle(principal_org, 1, Feature::OrgUnitManage).unwrap();
        let request = AuthorizationRequest::new(
            principal,
            Action::new(Feature::OrgUnitManage),
            AuthorizationResource::org_wide(resource_org, "org_unit"),
        );
        matches!(
            evaluate_with_facts(&request, &bundle, facts),
            CedarEvaluation::Allow { .. }
        )
    }

    #[test]
    fn only_a_holder_of_its_own_tenant_changes_its_units() {
        let org = OrgId::new();
        let holds = Facts::new().bool("actor_holds_permission", true);
        assert!(decide(org, org, &holds));
        assert!(!decide(
            org,
            org,
            &Facts::new().bool("actor_holds_permission", false)
        ));
        // Another tenant's unit, or a request without the fact, denies.
        assert!(!decide(org, OrgId::new(), &holds));
        assert!(!decide(org, org, &Facts::new()));
        assert!(!decide(
            org,
            org,
            &Facts::new().string("actor_holds_permission", "true")
        ));
    }
}
