// SPDX-License-Identifier: LicenseRef-Proprietary
//! Sensitive payroll requires both scoped payroll and sensitive-data authority.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;

const ACTION: &str = "pay_group_access";
const SCHEMA: &str = r#"entity Subject = { org: String, roles: Set<String> };
entity Resource = { org: String };
action pay_group_access appliesTo { principal: [Subject], resource: [Resource],
  context: { pay_allowed: Bool, sensitive: Bool, sensitive_allowed: Bool } };
"#;
const POLICIES: &str = r#"permit (principal, action == Action::"pay_group_access", resource)
when { principal.org == resource.org && context.pay_allowed
  && (!context.sensitive || context.sensitive_allowed) };"#;

pub(crate) fn decide(
    principal: &str,
    org: &str,
    pay_allowed: bool,
    sensitive: bool,
    sensitive_allowed: bool,
) -> Result<bool, String> {
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    BUNDLE
        .get_or_init(|| ActionBundle::compile(ACTION, SCHEMA, POLICIES))
        .as_ref()
        .map_err(Clone::clone)?
        .decide(
            principal,
            org,
            &[],
            org,
            &[
                ("pay_allowed", Fact::Bool(pay_allowed)),
                ("sensitive", Fact::Bool(sensitive)),
                ("sensitive_allowed", Fact::Bool(sensitive_allowed)),
            ],
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payroll_is_required_and_sensitive_clearance_cannot_be_substituted() {
        for (pay, sensitive, clearance, allowed) in [
            (false, false, false, false),
            (false, false, true, false),
            (false, true, false, false),
            (false, true, true, false),
            (true, false, false, true),
            (true, false, true, true),
            (true, true, false, false),
            (true, true, true, true),
        ] {
            assert_eq!(decide("u", "o", pay, sensitive, clearance), Ok(allowed));
        }
    }
}
