// SPDX-License-Identifier: LicenseRef-Proprietary
//! Only the self-attester can withdraw a current, unreviewed binding.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;

const ACTION: &str = "account_link_withdraw";
const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action account_link_withdraw appliesTo { principal: [Subject], resource: [Resource],
  context: { "subject_is_self": Bool, "pending": Bool }
};"#;
const POLICIES: &str = r#"permit(principal, action == Action::"account_link_withdraw", resource)
when { principal.org == resource.org && context.subject_is_self && context.pending };"#;

/// Missing facts and evaluation errors fail closed.
pub fn decide(
    actor: &str,
    org: &str,
    resource_org: &str,
    subject_is_self: bool,
    pending: bool,
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
                ("subject_is_self", Fact::Bool(subject_is_self)),
                ("pending", Fact::Bool(pending)),
            ],
        )
}
