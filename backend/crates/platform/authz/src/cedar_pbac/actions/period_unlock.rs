// SPDX-License-Identifier: LicenseRef-Proprietary
//! Cedar chooses waiting for a second person versus the governed solo path.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;

const ACTION: &str = "period_unlock";
const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action period_unlock appliesTo { principal: [Subject], resource: [Resource], context: {
  "actor_is_requester": Bool, "other_eligible_holders": Long, "step_up": Bool,
  "sole_holder_allowed": Bool, "setup_single_admin": Bool, "intent": String
} };"#;
const POLICIES: &str = r#"permit(principal, action == Action::"period_unlock", resource)
when { principal.org == resource.org && context.other_eligible_holders >= 0 &&
  ((context.intent == "request" && (context.other_eligible_holders > 0 || (context.sole_holder_allowed && context.setup_single_admin))) ||
   (context.intent == "wait" && context.step_up && context.other_eligible_holders > 0) ||
   (context.intent == "unlock" && context.step_up && context.other_eligible_holders == 0 && (context.sole_holder_allowed && context.setup_single_admin))) };
forbid(principal, action == Action::"period_unlock", resource)
when { context.intent == "unlock" && context.actor_is_requester }
unless { context.other_eligible_holders == 0 && context.step_up && (context.sole_holder_allowed && context.setup_single_admin) };"#;

fn bundle() -> Result<&'static ActionBundle, String> {
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    BUNDLE
        .get_or_init(|| ActionBundle::compile(ACTION, SCHEMA, POLICIES))
        .as_ref()
        .map_err(Clone::clone)
}

#[derive(Clone, Copy)]
pub enum Intent {
    Request,
    Wait,
    Unlock,
}

impl Intent {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Request => "request",
            Self::Wait => "wait",
            Self::Unlock => "unlock",
        }
    }
}

#[derive(Clone, Copy)]
pub struct UnlockFacts {
    pub actor_is_requester: bool,
    pub other_eligible_holders: i64,
    pub step_up: bool,
    pub sole_holder_allowed: bool,
    pub setup_single_admin: bool,
    pub intent: Intent,
}

#[must_use]
#[tracing::instrument(skip_all, fields(action = ACTION))]
pub fn decide(user: &str, org: &str, resource_org: &str, f: UnlockFacts) -> bool {
    let result = bundle()
        .and_then(|b| {
            b.decide(
                user,
                org,
                &[],
                resource_org,
                &[
                    ("actor_is_requester", Fact::Bool(f.actor_is_requester)),
                    (
                        "other_eligible_holders",
                        Fact::Long(f.other_eligible_holders),
                    ),
                    ("step_up", Fact::Bool(f.step_up)),
                    ("sole_holder_allowed", Fact::Bool(f.sole_holder_allowed)),
                    ("setup_single_admin", Fact::Bool(f.setup_single_admin)),
                    ("intent", Fact::Str(f.intent.as_str().to_owned())),
                ],
            )
        })
        .unwrap_or(false);
    tracing::debug!(
        action = ACTION,
        allowed = result,
        other_eligible_holders = f.other_eligible_holders,
        "Cedar period unlock decision"
    );
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_self_unlock_requires_step_up_and_the_governed_solo_mode() {
        let f = UnlockFacts {
            actor_is_requester: true,
            other_eligible_holders: 0,
            step_up: true,
            sole_holder_allowed: true,
            setup_single_admin: true,
            intent: Intent::Unlock,
        };
        assert!(decide("u", "o", "o", f));
        assert!(!decide(
            "u",
            "o",
            "o",
            UnlockFacts {
                setup_single_admin: false,
                ..f
            }
        ));
        assert!(!decide(
            "u",
            "o",
            "o",
            UnlockFacts {
                step_up: false,
                ..f
            }
        ));
        assert!(!decide(
            "u",
            "o",
            "o",
            UnlockFacts {
                sole_holder_allowed: false,
                ..f
            }
        ));
        assert!(!decide(
            "u",
            "o",
            "o",
            UnlockFacts {
                other_eligible_holders: 1,
                ..f
            }
        ));
        assert!(decide(
            "u",
            "o",
            "o",
            UnlockFacts {
                other_eligible_holders: 1,
                intent: Intent::Wait,
                ..f
            }
        ));
        assert!(!decide("u", "o", "foreign", f));
        assert!(!decide(
            "u",
            "o",
            "o",
            UnlockFacts {
                other_eligible_holders: -1,
                ..f
            }
        ));
        assert!(decide(
            "u",
            "o",
            "o",
            UnlockFacts {
                step_up: false,
                intent: Intent::Request,
                ..f
            }
        ));
        assert!(!decide(
            "u",
            "o",
            "o",
            UnlockFacts {
                step_up: false,
                intent: Intent::Wait,
                other_eligible_holders: 1,
                ..f
            }
        ));
        assert!(bundle().unwrap().decide("u", "o", &[], "o", &[]).is_err());
    }
}
