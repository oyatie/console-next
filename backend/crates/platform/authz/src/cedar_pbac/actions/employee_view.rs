// SPDX-License-Identifier: LicenseRef-Proprietary
//! Personal roster preferences require ownership, independently of HR grants.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;

const ACTION: &str = "employee_view";
const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action employee_view appliesTo { principal: [Subject], resource: [Resource],
context: { "is_owner": Bool } };"#;
const POLICIES: &str = r#"permit(principal, action == Action::"employee_view", resource)
when { principal.org == resource.org && context.is_owner };"#;

pub(crate) fn decide(
    actor: &str,
    org: &str,
    resource_org: &str,
    owner: bool,
) -> Result<bool, String> {
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
            &[("is_owner", Fact::Bool(owner))],
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ownership_and_tenant_are_both_required_and_missing_facts_deny() {
        assert_eq!(decide("a", "o", "o", true), Ok(true));
        assert_eq!(decide("a", "o", "o", false), Ok(false));
        assert_eq!(decide("a", "o", "foreign", true), Ok(false));
        let bundle = ActionBundle::compile(ACTION, SCHEMA, POLICIES).unwrap();
        assert!(bundle.decide("a", "o", &[], "o", &[]).is_err());
    }
}
