// SPDX-License-Identifier: LicenseRef-Proprietary
//! Tenant module admission is independent of payroll grants and self-service scope.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;

const ACTION: &str = "payroll_module_access";
const SCHEMA: &str = r#"entity Subject = { org: String, roles: Set<String> };
entity Resource = { org: String };
action payroll_module_access appliesTo { principal: [Subject], resource: [Resource],
  context: { enabled: Bool } };
"#;
const POLICIES: &str = r#"permit (principal, action == Action::"payroll_module_access", resource)
when { principal.org == resource.org && context.enabled };"#;

pub(crate) fn decide(principal: &str, org: &str, enabled: bool) -> Result<bool, String> {
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
            &[("enabled", Fact::Bool(enabled))],
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn module_must_be_enabled() {
        assert_eq!(decide("u", "o", false), Ok(false));
        assert_eq!(decide("u", "o", true), Ok(true));
    }
}
