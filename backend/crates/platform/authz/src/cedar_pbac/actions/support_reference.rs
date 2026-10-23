// SPDX-License-Identifier: LicenseRef-Proprietary
//! Same-tenant diagnostic access, using the server-resolved grant, never a role name.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;
pub const ACTION: &str = "support_reference";
pub const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action support_reference appliesTo { principal: [Subject], resource: [Resource],
context: { "has_support_grant": Bool } };"#;
pub const POLICIES: &str = r#"permit (principal, action == Action::"support_reference", resource);
@reason("support_reference_cross_tenant_denied")
forbid (principal, action == Action::"support_reference", resource)
when { principal.org != resource.org };
@reason("support_reference_grant_required")
forbid (principal, action == Action::"support_reference", resource)
when { !context.has_support_grant };"#;

pub fn bundle() -> Result<&'static ActionBundle, String> {
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    BUNDLE
        .get_or_init(|| ActionBundle::compile(ACTION, SCHEMA, POLICIES))
        .as_ref()
        .map_err(Clone::clone)
}

pub fn decide(
    actor: &str,
    org: &str,
    resource_org: &str,
    has_support_grant: bool,
) -> Result<(bool, Vec<String>), String> {
    bundle()?.decide_with_reasons(
        actor,
        org,
        &[],
        resource_org,
        &[("has_support_grant", Fact::Bool(has_support_grant))],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn without_policy(reason: &str) -> String {
        let marker = format!("@reason(\"{reason}\")");
        let (before, rest) = POLICIES.split_once(&marker).unwrap();
        let (_, after) = rest.split_once("};").unwrap();
        format!("{before}{after}")
    }
    #[test]
    fn configurable_grant_allows_without_a_role_literal() {
        assert_eq!(decide("operator", "a", "a", true), Ok((true, vec![])));
    }
    #[test]
    fn cross_tenant_refusal_is_decided_by_its_forbid() {
        assert_eq!(
            decide("operator", "b", "a", true),
            Ok((false, vec!["support_reference_cross_tenant_denied".into()]))
        );
        let removed = without_policy("support_reference_cross_tenant_denied");
        let bundle = ActionBundle::compile(ACTION, SCHEMA, &removed).unwrap();
        assert_eq!(
            bundle.decide_with_reasons(
                "operator",
                "b",
                &[],
                "a",
                &[("has_support_grant", Fact::Bool(true))]
            ),
            Ok((true, vec![]))
        );
    }
    #[test]
    fn missing_grant_refusal_is_decided_by_its_forbid() {
        assert_eq!(
            decide("operator", "a", "a", false),
            Ok((false, vec!["support_reference_grant_required".into()]))
        );
        let removed = without_policy("support_reference_grant_required");
        let bundle = ActionBundle::compile(ACTION, SCHEMA, &removed).unwrap();
        assert_eq!(
            bundle.decide_with_reasons(
                "operator",
                "a",
                &[],
                "a",
                &[("has_support_grant", Fact::Bool(false))]
            ),
            Ok((true, vec![]))
        );
    }
}
