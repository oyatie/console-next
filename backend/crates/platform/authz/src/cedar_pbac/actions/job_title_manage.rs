//! `job_title_manage` (BW-13 / MR-25; decisions #19, #26): add to or change
//! the tenant's 직급 · 직위 · 직책 · 직무 · 직군 lists. The lists are
//! tenant-wide, so the holder is whoever holds the catalog grant or the org
//! structure grant over the whole tenant; the use case computes that as
//! `actor_holds_permission` from the principal's existing doors (no role is
//! named here: the tenant ops account holds `org_change_apply` tenant-wide,
//! and a tenant role reaches it through its grant). Enforced and fail-closed
//! from the start: there is no legacy decision.

use super::super::action_schema::ActionSchema;
use super::super::facts::second_person::ACTOR_HOLDS_PERMISSION;
use crate::Feature;

pub const SCHEMA: ActionSchema = ActionSchema {
    denial_codes: &[],
    feature: Feature::JobTitleManage,
    version: "2026-10-emp-ui-job-title-manage-v1",
    facts: &[ACTOR_HOLDS_PERMISSION],
    policies: r#"permit(principal, action == Action::"job_title_manage", resource)
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
        let bundle = compile_action_bundle(principal_org, 1, Feature::JobTitleManage).unwrap();
        let request = AuthorizationRequest::new(
            principal,
            Action::new(Feature::JobTitleManage),
            AuthorizationResource::org_wide(resource_org, "job_title"),
        );
        matches!(
            evaluate_with_facts(&request, &bundle, facts),
            CedarEvaluation::Allow { .. }
        )
    }

    #[test]
    fn only_a_holder_of_its_own_tenant_manages_the_lists() {
        let org = OrgId::new();
        let holds = Facts::new().bool("actor_holds_permission", true);
        assert!(decide(org, org, &holds));
        assert!(!decide(
            org,
            org,
            &Facts::new().bool("actor_holds_permission", false)
        ));
        // Another tenant's catalog, or a request without the fact, denies.
        assert!(!decide(org, OrgId::new(), &holds));
        assert!(!decide(org, org, &Facts::new()));
        assert!(!decide(
            org,
            org,
            &Facts::new().string("actor_holds_permission", "true")
        ));
    }
}
