// SPDX-License-Identifier: LicenseRef-Proprietary
//! Governed tenant ops recovery; all party decisions remain in Cedar.

use super::{ActionBundle, Fact};
use std::sync::OnceLock;

const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action ops_recovery_approve, ops_recovery_issue, ops_recovery_cancel appliesTo {
  principal: [Subject], resource: [Resource],
  context: { "vendor": Bool, "active": Bool, "requester": Bool,
             "party": Bool, "during_hold": Bool }
};"#;
const POLICIES: &str = r#"permit(principal, action == Action::"ops_recovery_approve", resource)
when { context.vendor && context.active };
@reason("authz_sod_requester")
forbid(principal, action == Action::"ops_recovery_approve", resource)
when { context.requester };
permit(principal, action == Action::"ops_recovery_issue", resource)
when { context.vendor && context.active && context.party };
permit(principal, action == Action::"ops_recovery_cancel", resource)
when {
  context.active &&
  ((context.vendor && context.party) ||
   (!context.vendor && principal.org == resource.org && context.during_hold))
};"#;

/// The protected recovery transition.
#[derive(Debug, Clone, Copy)]
pub enum Action {
    Approve,
    Issue,
    Cancel,
}

/// Server-computed facts from the actor and locked recovery request.
#[derive(Debug, Clone, Copy)]
pub struct Facts {
    pub vendor: bool,
    pub active: bool,
    pub requester: bool,
    pub party: bool,
    pub during_hold: bool,
}

fn bundle(action: Action) -> Result<&'static ActionBundle, String> {
    static APPROVE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    static ISSUE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    static CANCEL: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    let (cached, name) = match action {
        Action::Approve => (&APPROVE, "ops_recovery_approve"),
        Action::Issue => (&ISSUE, "ops_recovery_issue"),
        Action::Cancel => (&CANCEL, "ops_recovery_cancel"),
    };
    cached
        .get_or_init(|| ActionBundle::compile(name, SCHEMA, POLICIES))
        .as_ref()
        .map_err(Clone::clone)
}

/// A compile or evaluation failure refuses the transition.
#[must_use]
pub fn decide(action: Action, user: &str, actor_org: &str, target_org: &str, facts: Facts) -> bool {
    bundle(action)
        .and_then(|b| {
            b.decide(
                user,
                actor_org,
                &[],
                target_org,
                &[
                    ("vendor", Fact::Bool(facts.vendor)),
                    ("active", Fact::Bool(facts.active)),
                    ("requester", Fact::Bool(facts.requester)),
                    ("party", Fact::Bool(facts.party)),
                    ("during_hold", Fact::Bool(facts.during_hold)),
                ],
            )
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]

    use super::*;

    const fn vendor() -> Facts {
        Facts {
            vendor: true,
            active: true,
            requester: false,
            party: true,
            during_hold: true,
        }
    }

    #[test]
    fn approve_requires_a_distinct_active_vendor_operator() {
        let f = vendor();
        assert!(decide(Action::Approve, "b", "platform", "tenant", f));
        assert!(!decide(
            Action::Approve,
            "a",
            "platform",
            "tenant",
            Facts {
                requester: true,
                ..f
            }
        ));
        assert!(!decide(
            Action::Approve,
            "b",
            "platform",
            "tenant",
            Facts { active: false, ..f }
        ));
        assert!(!decide(
            Action::Approve,
            "b",
            "tenant",
            "tenant",
            Facts { vendor: false, ..f }
        ));
    }

    #[test]
    fn issue_requires_an_active_vendor_party() {
        let f = vendor();
        assert!(decide(Action::Issue, "a", "platform", "tenant", f));
        assert!(decide(
            Action::Issue,
            "b",
            "platform",
            "tenant",
            Facts {
                requester: true,
                ..f
            }
        ));
        assert!(!decide(
            Action::Issue,
            "c",
            "platform",
            "tenant",
            Facts { party: false, ..f }
        ));
        assert!(!decide(
            Action::Issue,
            "a",
            "platform",
            "tenant",
            Facts { active: false, ..f }
        ));
        assert!(!decide(
            Action::Issue,
            "a",
            "tenant",
            "tenant",
            Facts { vendor: false, ..f }
        ));
    }

    #[test]
    fn cancel_permits_vendor_parties_or_the_tenant_during_the_hold() {
        let f = vendor();
        assert!(decide(Action::Cancel, "a", "platform", "tenant", f));
        assert!(!decide(
            Action::Cancel,
            "c",
            "platform",
            "tenant",
            Facts { party: false, ..f }
        ));
        let tenant = Facts {
            vendor: false,
            party: false,
            ..f
        };
        assert!(decide(Action::Cancel, "t", "tenant", "tenant", tenant));
        assert!(!decide(Action::Cancel, "t", "foreign", "tenant", tenant));
        assert!(!decide(Action::Cancel, "t", "", "tenant", tenant));
        assert!(!decide(
            Action::Cancel,
            "t",
            "tenant",
            "tenant",
            Facts {
                during_hold: false,
                ..tenant
            }
        ));
        assert!(!decide(
            Action::Cancel,
            "t",
            "tenant",
            "tenant",
            Facts {
                active: false,
                ..tenant
            }
        ));
    }

    #[test]
    fn invalid_bundles_and_missing_or_mistyped_facts_fail_closed() {
        assert!(ActionBundle::compile("ops_recovery_approve", SCHEMA, "invalid").is_err());
        for action in [Action::Approve, Action::Issue, Action::Cancel] {
            let b = bundle(action).expect("valid recovery policies");
            assert!(b.decide("a", "platform", &[], "tenant", &[]).is_err());
            assert!(
                b.decide(
                    "a",
                    "platform",
                    &[],
                    "tenant",
                    &[("vendor", Fact::Str("true".into()))]
                )
                .is_err()
            );
        }
    }
}
