// SPDX-License-Identifier: LicenseRef-Proprietary
//! Identity binding has no sole-holder exception, including for tenant ops.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;

const ACTION: &str = "account_link";
const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action account_link appliesTo {
  principal: [Subject], resource: [Resource],
  context: { "subject_is_self": Bool, "approving": Bool, "independent": Bool, "eligible": Bool }
};"#;
const POLICIES: &str = r#"permit (principal, action == Action::"account_link", resource)
when { principal.org == resource.org };
@reason("account_link_self_forbidden")
forbid (principal, action == Action::"account_link", resource)
when { context.subject_is_self };
@reason("account_link_second_person_required")
forbid (principal, action == Action::"account_link", resource)
when { context.approving && (!context.independent || !context.eligible) };"#;

#[derive(Debug, Clone, Copy)]
pub struct LinkFacts {
    pub subject_is_self: bool,
    pub approving: bool,
    pub independent: bool,
    pub eligible: bool,
}

/// Compilation, missing facts and evaluation diagnostics all fail closed.
#[must_use]
pub fn decide(actor: &str, org: &str, resource_org: &str, facts: LinkFacts) -> bool {
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    BUNDLE
        .get_or_init(|| ActionBundle::compile(ACTION, SCHEMA, POLICIES))
        .as_ref()
        .ok()
        .and_then(|bundle| {
            bundle
                .decide(
                    actor,
                    org,
                    &[],
                    resource_org,
                    &[
                        ("subject_is_self", Fact::Bool(facts.subject_is_self)),
                        ("approving", Fact::Bool(facts.approving)),
                        ("independent", Fact::Bool(facts.independent)),
                        ("eligible", Fact::Bool(facts.eligible)),
                    ],
                )
                .ok()
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    const REQUEST: LinkFacts = LinkFacts {
        subject_is_self: false,
        approving: false,
        independent: false,
        eligible: false,
    };
    #[test]
    fn another_accounts_link_can_be_requested_but_never_self_changed() {
        assert!(decide("actor", "org", "org", REQUEST));
        for approving in [false, true] {
            assert!(!decide(
                "actor",
                "org",
                "org",
                LinkFacts {
                    subject_is_self: true,
                    approving,
                    independent: true,
                    eligible: true,
                }
            ));
        }
    }
    #[test]
    fn approval_requires_both_independence_and_live_eligibility() {
        for (independent, eligible, allowed) in [
            (false, false, false),
            (false, true, false),
            (true, false, false),
            (true, true, true),
        ] {
            assert_eq!(
                decide(
                    "actor",
                    "org",
                    "org",
                    LinkFacts {
                        approving: true,
                        independent,
                        eligible,
                        ..REQUEST
                    }
                ),
                allowed
            );
        }
        assert!(!decide("actor", "org", "foreign", REQUEST));
    }
    #[test]
    fn missing_facts_fail_closed() {
        let result = ActionBundle::compile(ACTION, SCHEMA, POLICIES)
            .and_then(|bundle| bundle.decide("actor", "org", &[], "org", &[]));
        assert!(result.is_err());
    }
}
