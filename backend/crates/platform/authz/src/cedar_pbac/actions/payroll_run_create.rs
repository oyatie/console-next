// SPDX-License-Identifier: LicenseRef-Proprietary
//! Operational payroll starts only after the tenant goes live.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;

const ACTION: &str = "payroll_run_create";
const SCHEMA: &str = r#"entity Subject = { org: String, roles: Set<String> };
entity Resource = { org: String };
action payroll_run_create appliesTo { principal: [Subject], resource: [Resource],
  context: { operating: Bool } };
"#;
const POLICIES: &str = r#"permit (principal, action == Action::"payroll_run_create", resource)
when { principal.org == resource.org && context.operating };"#;

pub(crate) fn decide(principal: &str, org: &str, operating: bool) -> Result<bool, String> {
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
            &[("operating", Fact::Bool(operating))],
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_refuses_and_operating_admits() {
        assert_eq!(decide("u", "o", false), Ok(false));
        assert_eq!(decide("u", "o", true), Ok(true));
    }
}
