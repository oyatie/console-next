// SPDX-License-Identifier: LicenseRef-Proprietary
//! Cedar admission for employee import rollback and its second-person decision.

use std::sync::OnceLock;

use super::{ActionBundle, Fact};

pub const ACTION: &str = "import_rollback";
pub const SCHEMA_VERSION: &str = "2026-10-import-rollback-v1";

pub const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action import_rollback appliesTo {
  principal: [Subject],
  resource: [Resource],
  context: {
    "actor_holds_permission": Bool,
    "setup": Bool,
    "routed": Bool,
    "other_eligible_holders": Long,
    "sole_holder_refuse": Bool,
    "step_up": Bool,
    "filing": Bool,
    "actor_is_requester": Bool
  }
};
"#;

pub const POLICIES: &str = r#"permit(principal, action == Action::"import_rollback", resource)
when {
  principal.org == resource.org && context.actor_holds_permission &&
  (context.setup ||
   (context.routed && context.filing && context.other_eligible_holders > 0) ||
   (context.routed && !context.filing && !context.actor_is_requester) ||
   (context.step_up &&
    (!context.routed ||
     (context.filing && context.other_eligible_holders == 0 && !context.sole_holder_refuse))))
};
@reason("authz_sod_requester")
forbid(principal, action == Action::"import_rollback", resource)
when { context.routed && !context.filing && context.actor_is_requester };
"#;

/// Server-computed governance facts, never accepted from the request body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RollbackFacts {
    pub actor_holds_permission: bool,
    pub setup: bool,
    pub routed: bool,
    pub other_eligible_holders: i64,
    pub sole_holder_refuse: bool,
    pub step_up: bool,
    pub filing: bool,
    pub actor_is_requester: bool,
}

fn bundle() -> Result<&'static ActionBundle, String> {
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    BUNDLE
        .get_or_init(|| ActionBundle::compile(ACTION, SCHEMA, POLICIES))
        .as_ref()
        .map_err(Clone::clone)
}

/// Any compile or evaluation error denies admission.
///
/// # Errors
/// Cedar diagnostics when evaluation could not complete cleanly.
pub fn decide(
    principal: &str,
    org: &str,
    resource_org: &str,
    facts: &RollbackFacts,
) -> Result<bool, String> {
    bundle()?.decide(
        principal,
        org,
        &[],
        resource_org,
        &[
            (
                "actor_holds_permission",
                Fact::Bool(facts.actor_holds_permission),
            ),
            ("setup", Fact::Bool(facts.setup)),
            ("routed", Fact::Bool(facts.routed)),
            (
                "other_eligible_holders",
                Fact::Long(facts.other_eligible_holders),
            ),
            ("sole_holder_refuse", Fact::Bool(facts.sole_holder_refuse)),
            ("step_up", Fact::Bool(facts.step_up)),
            ("filing", Fact::Bool(facts.filing)),
            ("actor_is_requester", Fact::Bool(facts.actor_is_requester)),
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::{RollbackFacts, decide};

    fn facts() -> RollbackFacts {
        RollbackFacts {
            actor_holds_permission: true,
            setup: false,
            routed: false,
            other_eligible_holders: 1,
            sole_holder_refuse: false,
            step_up: true,
            filing: true,
            actor_is_requester: true,
        }
    }

    fn allowed(facts: RollbackFacts) -> bool {
        decide("actor", "org", "org", &facts).expect("valid Cedar bundle")
    }

    #[test]
    fn setup_and_verified_policy_none_are_admitted() {
        assert!(allowed(facts()));
        assert!(allowed(RollbackFacts {
            setup: true,
            step_up: false,
            ..facts()
        }));
        assert!(allowed(RollbackFacts {
            sole_holder_refuse: true,
            ..facts()
        }));
    }

    #[test]
    fn permission_and_tenant_are_required() {
        assert!(!allowed(RollbackFacts {
            actor_holds_permission: false,
            ..facts()
        }));
        assert!(!decide("actor", "org", "other", &facts()).unwrap());
    }

    #[test]
    fn operating_policy_none_requires_step_up() {
        assert!(!allowed(RollbackFacts {
            step_up: false,
            ..facts()
        }));
    }

    #[test]
    fn routed_filing_needs_another_holder_or_permitted_verified_sole_holder() {
        assert!(allowed(RollbackFacts {
            routed: true,
            step_up: false,
            ..facts()
        }));
        assert!(allowed(RollbackFacts {
            routed: true,
            other_eligible_holders: 0,
            ..facts()
        }));
        assert!(!allowed(RollbackFacts {
            routed: true,
            other_eligible_holders: 0,
            step_up: false,
            ..facts()
        }));
        assert!(!allowed(RollbackFacts {
            routed: true,
            other_eligible_holders: 0,
            sole_holder_refuse: true,
            ..facts()
        }));
    }

    #[test]
    fn routed_requester_never_decides_even_with_setup_or_step_up() {
        assert!(!allowed(RollbackFacts {
            routed: true,
            filing: false,
            ..facts()
        }));
        assert!(!allowed(RollbackFacts {
            setup: true,
            routed: true,
            filing: false,
            ..facts()
        }));
        assert!(!allowed(RollbackFacts {
            routed: true,
            filing: false,
            other_eligible_holders: 0,
            ..facts()
        }));
        assert!(allowed(RollbackFacts {
            routed: true,
            filing: false,
            actor_is_requester: false,
            step_up: false,
            ..facts()
        }));
    }
}
