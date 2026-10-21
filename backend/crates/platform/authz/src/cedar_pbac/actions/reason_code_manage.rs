// SPDX-License-Identifier: LicenseRef-Proprietary
//! `reason_code_manage` (AD-F17; decisions D0.1, BW-07): adding, deactivating,
//! and reordering tenant reason codes in open domains.
//!
//! Decided in Cedar: an actor holding the tenant-wide reason-code management
//! permission can manage codes in open domains. Closed (governance) domains
//! are refused. Unenrolled or denied requests cannot manage reason codes.

use super::super::action_schema::{ActionSchema, FactType, RequiredFact};
use super::super::facts::second_person::ACTOR_HOLDS_PERMISSION;
use crate::Feature;

pub const DOMAIN_TENANT_EXTENSIBLE: RequiredFact = RequiredFact {
    name: "domain_tenant_extensible",
    ty: FactType::Bool,
};

pub const SCHEMA: ActionSchema = ActionSchema {
    feature: Feature::ReasonCodeManage,
    version: "2026-10-reason-code-manage-v1",
    facts: &[ACTOR_HOLDS_PERMISSION, DOMAIN_TENANT_EXTENSIBLE],
    policies: r#"@reason("reason_domain_closed")
forbid(principal, action == Action::"reason_code_manage", resource)
when {
  !context.domain_tenant_extensible
};
permit(principal, action == Action::"reason_code_manage", resource)
when {
  principal.org == resource.org &&
  context.actor_holds_permission &&
  context.domain_tenant_extensible
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

    fn decide(principal_org: OrgId, resource_org: OrgId, facts: &Facts) -> CedarEvaluation {
        let principal = Principal::new(
            UserId::new(),
            principal_org,
            Default::default(),
            BranchScope::All,
        );
        let bundle = compile_action_bundle(principal_org, 1, Feature::ReasonCodeManage).unwrap();
        let request = AuthorizationRequest::new(
            principal,
            Action::new(Feature::ReasonCodeManage),
            AuthorizationResource::org_wide(resource_org, "reason_code"),
        );
        evaluate_with_facts(&request, &bundle, facts)
    }

    #[test]
    fn granted_holder_permits_open_domains() {
        let org = OrgId::new();
        let facts = Facts::new()
            .bool("actor_holds_permission", true)
            .bool("domain_tenant_extensible", true);
        assert!(matches!(
            decide(org, org, &facts),
            CedarEvaluation::Allow { .. }
        ));
    }

    #[test]
    fn closed_domain_denies() {
        let org = OrgId::new();
        let facts = Facts::new()
            .bool("actor_holds_permission", true)
            .bool("domain_tenant_extensible", false);
        assert!(matches!(
            decide(org, org, &facts),
            CedarEvaluation::Deny { .. }
        ));
    }

    #[test]
    fn missing_permission_or_other_tenant_denies() {
        let org = OrgId::new();
        let other = OrgId::new();
        let facts = Facts::new()
            .bool("actor_holds_permission", false)
            .bool("domain_tenant_extensible", true);
        assert!(matches!(
            decide(org, org, &facts),
            CedarEvaluation::Deny { .. }
        ));

        let ok_facts = Facts::new()
            .bool("actor_holds_permission", true)
            .bool("domain_tenant_extensible", true);
        assert!(matches!(
            decide(org, other, &ok_facts),
            CedarEvaluation::Deny { .. }
        ));
    }
}
