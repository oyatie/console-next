// SPDX-License-Identifier: LicenseRef-Proprietary
//! `settings_manage` (AD-F17; decisions D0.1, D0.3): changing tenant settings
//! in the registry.
//!
//! Settings writes are decided in Cedar: tightening applies immediately, while
//! loosening requires a passkey step-up and takes effect after a 24-hour notice
//! period. The action schema declares `actor_holds_permission`, `direction`,
//! and `step_up` as required facts. Fail-closed: unenrolled or denied requests
//! cannot change settings.

use super::super::action_schema::{ActionSchema, FactType, RequiredFact};
use super::super::facts::scope::SCOPE_BLOCK;
use super::super::facts::second_person::ACTOR_HOLDS_PERMISSION;
use crate::Feature;

pub const DIRECTION: RequiredFact = RequiredFact {
    name: "direction",
    ty: FactType::String,
};

pub const STEP_UP: RequiredFact = RequiredFact {
    name: "step_up",
    ty: FactType::Bool,
};

pub const SCHEMA: ActionSchema = ActionSchema {
    denial_codes: &["out_of_scope", "scope_tenant_wide_only", "step_up_required"],
    feature: Feature::SettingsManage,
    version: "2026-10-settings-manage-v3",
    facts: &[
        ACTOR_HOLDS_PERMISSION,
        DIRECTION,
        STEP_UP,
        SCOPE_BLOCK[0],
        SCOPE_BLOCK[1],
        SCOPE_BLOCK[2],
    ],
    policies: r#"@reason("scope_tenant_wide_only")
forbid(principal, action == Action::"settings_manage", resource)
when {
  context.actor_holds_permission && !context.scope_tenant && context.resource_entities.isEmpty()
};
@reason("out_of_scope")
forbid(principal, action == Action::"settings_manage", resource)
when {
  context.actor_holds_permission && !context.scope_tenant && !context.resource_entities.isEmpty() &&
  !context.scope_entities.containsAny(context.resource_entities)
};
@reason("step_up_required")
forbid(principal, action == Action::"settings_manage", resource)
when {
  (principal.is_tenant_ops || context.actor_holds_permission) &&
  (context.scope_tenant || context.scope_entities.containsAny(context.resource_entities)) &&
  context.direction == "loosen" && !context.step_up
};
permit(principal, action == Action::"settings_manage", resource)
when {
  principal.org == resource.org &&
  (principal.is_tenant_ops || context.actor_holds_permission) &&
  (context.scope_tenant || context.scope_entities.containsAny(context.resource_entities)) &&
  (context.direction != "loosen" || context.step_up)
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
        let bundle = compile_action_bundle(principal_org, 1, Feature::SettingsManage).unwrap();
        let request = AuthorizationRequest::new(
            principal,
            Action::new(Feature::SettingsManage),
            AuthorizationResource::org_wide(resource_org, "setting"),
        );
        evaluate_with_facts(&request, &bundle, facts)
    }

    #[test]
    fn granted_holder_permits_tighten_and_neutral_without_step_up() {
        let org = OrgId::new();
        for dir in ["tighten", "neutral"] {
            let facts = crate::cedar_pbac::facts::scope::scope_facts(Facts::new(), None, &[])
                .bool("actor_holds_permission", true)
                .string("direction", dir)
                .bool("step_up", false);
            assert!(matches!(
                decide(org, org, &facts),
                CedarEvaluation::Allow { .. }
            ));
        }
    }

    #[test]
    fn loosening_requires_step_up() {
        let org = OrgId::new();
        let without_step_up = crate::cedar_pbac::facts::scope::scope_facts(Facts::new(), None, &[])
            .bool("actor_holds_permission", true)
            .string("direction", "loosen")
            .bool("step_up", false);
        let res = decide(org, org, &without_step_up);
        assert!(matches!(res, CedarEvaluation::Deny { .. }));

        let with_step_up = crate::cedar_pbac::facts::scope::scope_facts(Facts::new(), None, &[])
            .bool("actor_holds_permission", true)
            .string("direction", "loosen")
            .bool("step_up", true);
        assert!(matches!(
            decide(org, org, &with_step_up),
            CedarEvaluation::Allow { .. }
        ));
    }

    #[test]
    fn missing_permission_or_other_tenant_denies() {
        let org = OrgId::new();
        let other = OrgId::new();
        let facts = crate::cedar_pbac::facts::scope::scope_facts(Facts::new(), None, &[])
            .bool("actor_holds_permission", false)
            .string("direction", "tighten")
            .bool("step_up", false);
        assert!(matches!(
            decide(org, org, &facts),
            CedarEvaluation::Deny { .. }
        ));

        let ok_facts = crate::cedar_pbac::facts::scope::scope_facts(Facts::new(), None, &[])
            .bool("actor_holds_permission", true)
            .string("direction", "tighten")
            .bool("step_up", false);
        assert!(matches!(
            decide(org, other, &ok_facts),
            CedarEvaluation::Deny { .. }
        ));
    }
    #[test]
    fn tenant_ops_policy_door_stays_tenant_bound() {
        let org = OrgId::new();
        let principal = Principal::new(UserId::new(), org, Default::default(), BranchScope::All)
            .with_tenant_ops(true);
        let bundle = compile_action_bundle(org, 1, Feature::SettingsManage).unwrap();
        let facts = crate::cedar_pbac::facts::scope::scope_facts(Facts::new(), None, &[])
            .bool("actor_holds_permission", false)
            .string("direction", "tighten")
            .bool("step_up", false);
        for (resource_org, allowed) in [(org, true), (OrgId::new(), false)] {
            let request = AuthorizationRequest::new(
                principal.clone(),
                Action::new(Feature::SettingsManage),
                AuthorizationResource::org_wide(resource_org, "setting"),
            );
            let result = evaluate_with_facts(&request, &bundle, &facts);
            assert_eq!(
                matches!(result, CedarEvaluation::Allow { .. }),
                allowed,
                "{result:?}"
            );
        }
    }
    #[test]
    fn cedar_scope_block_reaches_descendants_but_never_parents_or_other_entities() {
        let org = OrgId::new();
        let (entity, workplace, other) = (
            uuid::Uuid::new_v4(),
            uuid::Uuid::new_v4(),
            uuid::Uuid::new_v4(),
        );
        for (granted, resource, allowed) in [
            (vec![entity], vec![workplace, entity], true),
            (vec![other], vec![workplace, entity], false),
            (vec![workplace], vec![workplace, entity], true),
            (vec![workplace], vec![entity], false),
            (vec![workplace], vec![], false),
        ] {
            let facts = crate::cedar_pbac::facts::scope::scope_facts(
                Facts::new(),
                Some(&granted),
                &resource,
            )
            .bool("actor_holds_permission", true)
            .string("direction", "tighten")
            .bool("step_up", false);
            assert_eq!(
                matches!(decide(org, org, &facts), CedarEvaluation::Allow { .. }),
                allowed
            );
        }
    }
}
