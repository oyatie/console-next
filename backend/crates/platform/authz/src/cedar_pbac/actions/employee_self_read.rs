// SPDX-License-Identifier: LicenseRef-Proprietary
//! Self-service reads require the live employee link, independently of pay grants.
use std::sync::OnceLock;

use super::{ActionBundle, Fact};

const ACTION: &str = "employee_self_read";
const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action employee_self_read appliesTo { principal: [Subject], resource: [Resource],
context: { "subject_is_self": Bool } };"#;
const POLICIES: &str = r#"permit(principal, action == Action::"employee_self_read", resource)
when { principal.org == resource.org && context.subject_is_self };"#;

pub(crate) fn decide(actor: &str, org: &str, subject_is_self: bool) -> Result<bool, String> {
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    BUNDLE
        .get_or_init(|| ActionBundle::compile(ACTION, SCHEMA, POLICIES))
        .as_ref()
        .map_err(Clone::clone)?
        .decide(
            actor,
            org,
            &[],
            org,
            &[("subject_is_self", Fact::Bool(subject_is_self))],
        )
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_own_record_is_readable_and_missing_or_foreign_facts_fail_closed() {
        use super::*;
        assert_eq!(decide("a", "o", true), Ok(true));
        assert_eq!(decide("a", "o", false), Ok(false));
        let bundle = ActionBundle::compile(ACTION, SCHEMA, POLICIES).unwrap();
        assert!(bundle.decide("a", "o", &[], "o", &[]).is_err());
        assert_eq!(
            bundle.decide(
                "a",
                "o",
                &[],
                "foreign",
                &[("subject_is_self", Fact::Bool(true))]
            ),
            Ok(false)
        );
    }
}
