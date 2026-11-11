//! `roster_field_manage`: define the fields a tenant adds to its personnel
//! card (add one, rename it, retire it). The definitions are tenant-wide, so
//! the holder is whoever holds this grant or the HR 등록·수정 grant over the
//! whole tenant; the use case computes that as `actor_holds_permission` from
//! the principal's existing doors. Fail-closed: there is no legacy decision.

use super::super::action_schema::ActionSchema;
use super::super::facts::second_person::ACTOR_HOLDS_PERMISSION;
use crate::Feature;

pub const SCHEMA: ActionSchema = ActionSchema {
    denial_codes: &[],
    feature: Feature::RosterFieldManage,
    version: "2026-11-roster-field-manage-v1",
    facts: &[ACTOR_HOLDS_PERMISSION],
    policies: r#"permit(principal, action == Action::"roster_field_manage", resource)
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
        let bundle = compile_action_bundle(principal_org, 1, Feature::RosterFieldManage).unwrap();
        let request = AuthorizationRequest::new(
            principal,
            Action::new(Feature::RosterFieldManage),
            AuthorizationResource::org_wide(resource_org, "roster_field"),
        );
        matches!(
            evaluate_with_facts(&request, &bundle, facts),
            CedarEvaluation::Allow { .. }
        )
    }

    #[test]
    fn only_a_holder_of_its_own_tenant_defines_fields() {
        let org = OrgId::new();
        let holds = Facts::new().bool("actor_holds_permission", true);
        assert!(decide(org, org, &holds));
        assert!(!decide(
            org,
            org,
            &Facts::new().bool("actor_holds_permission", false)
        ));
        assert!(!decide(org, OrgId::new(), &holds));
        assert!(!decide(org, org, &Facts::new()));
    }
}
