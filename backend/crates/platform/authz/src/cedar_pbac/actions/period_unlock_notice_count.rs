// SPDX-License-Identifier: LicenseRef-Proprietary
//! A notice count belongs to its recipient, independently of approval eligibility.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;

const ACTION: &str = "period_unlock_notice_count";
const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action period_unlock_notice_count appliesTo { principal: [Subject], resource: [Resource],
context: { "is_recipient": Bool } };"#;
const POLICIES: &str = r#"permit(principal, action == Action::"period_unlock_notice_count", resource)
when { principal.org == resource.org && context.is_recipient };"#;

pub(crate) fn decide(
    actor: &str,
    org: &str,
    resource_org: &str,
    recipient: bool,
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
            &[("is_recipient", Fact::Bool(recipient))],
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_the_recipient_in_this_tenant_can_count_notices() {
        assert_eq!(decide("a", "o", "o", true), Ok(true));
        assert_eq!(decide("a", "o", "o", false), Ok(false));
        assert_eq!(decide("a", "o", "foreign", true), Ok(false));
        let bundle = ActionBundle::compile(ACTION, SCHEMA, POLICIES).unwrap();
        assert!(bundle.decide("a", "o", &[], "o", &[]).is_err());
    }
}
