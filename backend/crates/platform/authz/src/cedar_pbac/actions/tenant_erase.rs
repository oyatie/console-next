// SPDX-License-Identifier: LicenseRef-Proprietary
//! Destructive approval never accepts the requester as the second operator.
use super::{ActionBundle, Fact};
use crate::cedar_pbac::facts::second_person;
use std::sync::OnceLock;
const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action tenant_erase_approve appliesTo { principal: [Subject], resource: [Resource],
context: { "actor_is_requester": Bool, "step_up": Bool, "actor_holds_permission": Bool, "other_eligible_holders": Long } };"#;
const POLICY: &str = r#"permit(principal, action == Action::"tenant_erase_approve", resource)
when { context.step_up && context.actor_holds_permission && context.other_eligible_holders > 0 };
@reason("erase_same_operator")
forbid(principal, action == Action::"tenant_erase_approve", resource) when { context.actor_is_requester };"#;
#[must_use]
pub fn approve(
    user: &str,
    org: &str,
    target: &str,
    requester: bool,
    eligible: bool,
    others: i64,
) -> bool {
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    BUNDLE
        .get_or_init(|| ActionBundle::compile("tenant_erase_approve", SCHEMA, POLICY))
        .as_ref()
        .ok()
        .and_then(|b| {
            b.decide(
                user,
                org,
                &[],
                target,
                &[
                    (
                        second_person::ACTOR_IS_REQUESTER.name,
                        Fact::Bool(requester),
                    ),
                    (second_person::STEP_UP.name, Fact::Bool(true)),
                    (
                        second_person::ACTOR_HOLDS_PERMISSION.name,
                        Fact::Bool(eligible),
                    ),
                    (
                        second_person::OTHER_ELIGIBLE_HOLDERS.name,
                        Fact::Long(others),
                    ),
                ],
            )
            .ok()
        })
        .unwrap_or(false)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_a_distinct_enrolled_operator_can_approve() {
        assert!(approve("b", "platform", "tenant", false, true, 1));
        assert!(!approve("a", "platform", "tenant", true, true, 1));
        assert!(!approve("b", "platform", "tenant", false, false, 1));
        assert!(!approve("b", "platform", "tenant", false, true, 0));
    }
}
