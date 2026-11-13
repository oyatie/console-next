// SPDX-License-Identifier: LicenseRef-Proprietary
//! Solo binding offer only; this decision never authorizes an identity write.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;

const ACTION: &str = "account_link_solo";
const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action account_link_solo appliesTo {
  principal: [Subject], resource: [Resource],
  context: { "subject_is_self": Bool, "operator": Bool, "unbound": Bool,
             "holds_permission": Bool, "other_holder": Bool }
};"#;
const POLICIES: &str = r#"permit(principal, action == Action::"account_link_solo", resource)
when { principal.org == resource.org && context.subject_is_self && context.operator &&
       context.unbound && context.holds_permission && !context.other_holder };"#;

#[derive(Debug, Clone, Copy)]
pub struct Facts {
    pub subject_is_self: bool,
    pub operator: bool,
    pub unbound: bool,
    pub holds_permission: bool,
    pub other_holder: bool,
}

/// Missing facts, compilation failures and evaluation errors fail closed.
pub fn decide(actor: &str, org: &str, resource_org: &str, f: Facts) -> Result<bool, String> {
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    BUNDLE
        .get_or_init(|| ActionBundle::compile(ACTION, SCHEMA, POLICIES))
        .as_ref()
        .map_err(Clone::clone)?
        .decide(
            actor,
            org,
            &[],
            resource_org,
            &[
                ("subject_is_self", Fact::Bool(f.subject_is_self)),
                ("operator", Fact::Bool(f.operator)),
                ("unbound", Fact::Bool(f.unbound)),
                ("holds_permission", Fact::Bool(f.holds_permission)),
                ("other_holder", Fact::Bool(f.other_holder)),
            ],
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_mistyped_facts_fail_closed() {
        let bundle = ActionBundle::compile(ACTION, SCHEMA, POLICIES).unwrap();
        let facts = [
            ("subject_is_self", Fact::Bool(true)),
            ("operator", Fact::Bool(true)),
            ("unbound", Fact::Bool(true)),
            ("holds_permission", Fact::Bool(true)),
            ("other_holder", Fact::Bool(false)),
        ];
        for index in 0..facts.len() {
            let mut missing = facts.to_vec();
            missing.remove(index);
            assert!(bundle.decide("actor", "org", &[], "org", &missing).is_err());
            let mut mistyped = facts.to_vec();
            mistyped[index].1 = Fact::Long(1);
            assert!(
                bundle
                    .decide("actor", "org", &[], "org", &mistyped)
                    .is_err()
            );
        }
    }
}
