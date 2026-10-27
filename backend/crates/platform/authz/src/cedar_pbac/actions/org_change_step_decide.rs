// SPDX-License-Identifier: LicenseRef-Proprietary
//! In-transaction org approval admission and natural-person separation of duties.
use super::{ActionBundle, Fact};
use console_kernel_core::{ErrorKind, KernelError};
use std::sync::OnceLock;

const ACTION: &str = "org_change_step_decide";
const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action org_change_step_decide appliesTo {
  principal: [Subject], resource: [Resource],
  context: { "holds_permission": Bool, "identities_bound": Bool,
             "actor_is_drafter": Bool, "actor_decided_prior_step": Bool,
             "merge_requested": Bool }
};"#;
const POLICIES: &str = r#"permit(principal, action == Action::"org_change_step_decide", resource)
when { principal.org == resource.org && context.holds_permission };
@reason("org_change.refuse.identity_unbound")
forbid(principal, action == Action::"org_change_step_decide", resource)
unless { context.identities_bound };
@reason("org_change_sod_violation")
forbid(principal, action == Action::"org_change_step_decide", resource)
when { context.actor_is_drafter || context.actor_decided_prior_step };
@reason("lifecycle.refuse.merge_not_allowed")
forbid(principal, action == Action::"org_change_step_decide", resource)
when { context.merge_requested };
"#;

#[derive(Debug, Clone, Copy)]
pub struct Facts {
    pub holds_permission: bool,
    pub identities_bound: bool,
    pub actor_is_drafter: bool,
    pub actor_decided_prior_step: bool,
    pub merge_requested: bool,
}

pub fn enforce(
    actor: &str,
    org: &str,
    resource_org: &str,
    facts: Facts,
) -> Result<(), KernelError> {
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    let decision = BUNDLE
        .get_or_init(|| ActionBundle::compile(ACTION, SCHEMA, POLICIES))
        .as_ref()
        .map_err(Clone::clone)
        .and_then(|b| {
            b.decide_with_reasons(
                actor,
                org,
                &[],
                resource_org,
                &[
                    ("holds_permission", Fact::Bool(facts.holds_permission)),
                    ("identities_bound", Fact::Bool(facts.identities_bound)),
                    ("actor_is_drafter", Fact::Bool(facts.actor_is_drafter)),
                    (
                        "actor_decided_prior_step",
                        Fact::Bool(facts.actor_decided_prior_step),
                    ),
                    ("merge_requested", Fact::Bool(facts.merge_requested)),
                ],
            )
        });
    let Ok((allowed, reasons)) = decision else {
        return Err(KernelError::forbidden("org approval facts unavailable"));
    };
    if allowed {
        return Ok(());
    }
    for (code, kind) in [
        ("lifecycle.refuse.merge_not_allowed", ErrorKind::Conflict),
        ("org_change.refuse.identity_unbound", ErrorKind::Forbidden),
        ("org_change_sod_violation", ErrorKind::Conflict),
    ] {
        if reasons.iter().any(|reason| reason == code) {
            return Err(KernelError::new(kind, "org approval refused").with_code(code));
        }
    }
    Err(KernelError::forbidden("org approval permission required"))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]
    use super::*;

    fn facts() -> Facts {
        Facts {
            holds_permission: true,
            identities_bound: true,
            actor_is_drafter: false,
            actor_decided_prior_step: false,
            merge_requested: false,
        }
    }

    #[test]
    fn distinct_people_and_live_authority_are_required() {
        assert!(enforce("actor", "org", "org", facts()).is_ok());
        for (facts, code) in [
            (
                Facts {
                    actor_is_drafter: true,
                    ..facts()
                },
                "org_change_sod_violation",
            ),
            (
                Facts {
                    actor_decided_prior_step: true,
                    ..facts()
                },
                "org_change_sod_violation",
            ),
            (
                Facts {
                    identities_bound: false,
                    ..facts()
                },
                "org_change.refuse.identity_unbound",
            ),
            (
                Facts {
                    merge_requested: true,
                    ..facts()
                },
                "lifecycle.refuse.merge_not_allowed",
            ),
        ] {
            assert_eq!(
                enforce("actor", "org", "org", facts)
                    .err()
                    .and_then(|e| e.code),
                Some(code)
            );
        }
        assert!(enforce("actor", "org", "other", facts()).is_err());
        assert!(
            enforce(
                "actor",
                "org",
                "org",
                Facts {
                    holds_permission: false,
                    ..facts()
                }
            )
            .is_err()
        );
    }

    #[test]
    fn absent_or_mistyped_facts_fail_closed() {
        let bundle = ActionBundle::compile(ACTION, SCHEMA, POLICIES).expect("strict Cedar schema");
        assert!(bundle.decide("actor", "org", &[], "org", &[]).is_err());
        assert!(
            bundle
                .decide(
                    "actor",
                    "org",
                    &[],
                    "org",
                    &[("holds_permission", Fact::Str("true".into()))]
                )
                .is_err()
        );
    }
}
