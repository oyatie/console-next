// SPDX-License-Identifier: LicenseRef-Proprietary
//! Self-attestation review requires live account management and distinct natural people.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;

const ACTION: &str = "account_link_review";
const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action account_link_review appliesTo {
  principal: [Subject], resource: [Resource],
  context: { "independent": Bool, "eligible": Bool }
};"#;
const POLICIES: &str = r#"permit(principal, action == Action::"account_link_review", resource)
when { principal.org == resource.org && context.independent && context.eligible };"#;

/// Missing facts, compilation and evaluation errors fail closed.
pub fn decide(
    actor: &str,
    org: &str,
    resource_org: &str,
    independent: bool,
    eligible: bool,
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
            &[
                ("independent", Fact::Bool(independent)),
                ("eligible", Fact::Bool(eligible)),
            ],
        )
}
