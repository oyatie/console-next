//! `legal_entity_manage` (decisions #14.2): register and revise 법인 ·
//! 사업자등록 · 사업장, and void them during setup. Its own permission, apart
//! from the org-change grants, so 부서 restructuring and 사업자등록증-level data
//! can be granted independently. Holders: SUPER_ADMIN and EXECUTIVE (the
//! holders of `org_change_apply`, which these writes used before), within
//! their scope grants (decisions #15: the same rule for any 법인, the holder's
//! employer or not). Backstop: the tenant-phase admission and the entity
//! tables' triggers. Enforced and fail-closed from the start.

use super::super::action_schema::ActionSchema;
use super::super::facts::scope::SCOPE_BLOCK;
use crate::Feature;

pub const SCHEMA: ActionSchema = ActionSchema {
    feature: Feature::LegalEntityManage,
    version: "2026-10-pa-ent-legal-entity-manage-v1",
    facts: &SCOPE_BLOCK,
    policies: r#"permit(principal, action == Action::"legal_entity_manage", resource)
when {
  principal.org == resource.org &&
  (principal.roles.contains("SUPER_ADMIN") || principal.roles.contains("EXECUTIVE")) &&
  (context.scope_tenant || context.scope_entities.containsAny(context.resource_entities))
};
"#,
};

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use console_kernel_core::{BranchScope, OrgId, UserId};
    use uuid::Uuid;

    use crate::cedar_pbac::action_schema::compile_action_bundle;
    use crate::cedar_pbac::facts::scope::scope_facts;
    use crate::cedar_pbac::facts::{Facts, evaluate_with_facts};
    use crate::{
        Action, AuthorizationRequest, AuthorizationResource, CedarEvaluation, Feature, Principal,
        Role,
    };

    fn decide(roles: Vec<Role>, granted: Option<&[Uuid]>, resource: &[Uuid]) -> bool {
        let org = OrgId::one();
        let principal = Principal::new(
            UserId::new(),
            org,
            roles.into_iter().collect(),
            BranchScope::All,
        );
        let bundle = compile_action_bundle(org, 1, Feature::LegalEntityManage).unwrap();
        let request = AuthorizationRequest::new(
            principal,
            Action::new(Feature::LegalEntityManage),
            AuthorizationResource::org_wide(org, "legal_entity"),
        );
        let facts = scope_facts(Facts::new(), granted, resource);
        matches!(
            evaluate_with_facts(&request, &bundle, &facts),
            CedarEvaluation::Allow { .. }
        )
    }

    #[test]
    fn the_org_change_holders_manage_entities_and_nobody_else() {
        let a = Uuid::new_v4();
        assert!(decide(vec![Role::SuperAdmin], None, &[a]));
        assert!(decide(vec![Role::Executive], None, &[]));
        for role in [
            Role::Admin,
            Role::Member,
            Role::Mechanic,
            Role::Receptionist,
        ] {
            assert!(!decide(vec![role], None, &[a]), "{role:?}");
        }
    }

    #[test]
    fn a_grant_reaches_its_own_entity_or_workplace_only() {
        let (a, b, a_site) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let on_b = [b];
        // A grant on 법인 B works for anyone holding it (decisions #15.1, #15.3).
        assert!(decide(vec![Role::Executive], Some(&on_b), &[b]));
        // Nothing crosses without a grant (#15.4), and a new 법인 needs the tenant.
        assert!(!decide(vec![Role::Executive], Some(&on_b), &[a, a_site]));
        assert!(!decide(vec![Role::Executive], Some(&on_b), &[]));
        // A 사업장 grant reaches that 사업장's records.
        assert!(decide(
            vec![Role::SuperAdmin],
            Some(&[a_site]),
            &[a, a_site]
        ));
    }
}
