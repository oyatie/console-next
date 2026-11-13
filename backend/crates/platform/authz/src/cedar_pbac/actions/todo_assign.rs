// SPDX-License-Identifier: LicenseRef-Proprietary
//! Asking a colleague of one's own tenant for a follow-up. The use case
//! computes `holds` from the tenant-wide people-directory manage authority, so
//! the founder and tenant-wide HR editors may ask; a support session never may.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;

const ACTION: &str = "todo_assign";
const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action todo_assign appliesTo { principal: [Subject], resource: [Resource],
 context: { "holds": Bool, "support_session": Bool } };"#;
const POLICIES: &str = r#"permit(principal, action == Action::"todo_assign", resource)
when { principal.org == resource.org && context.holds && !context.support_session };"#;

fn bundle() -> Result<&'static ActionBundle, String> {
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    BUNDLE
        .get_or_init(|| ActionBundle::compile(ACTION, SCHEMA, POLICIES))
        .as_ref()
        .map_err(Clone::clone)
}

/// Whether `actor` of `org` may ask someone in `resource_org`. Compilation or
/// evaluation diagnostics are a refusal.
#[must_use]
pub fn decide(
    actor: &str,
    org: &str,
    resource_org: &str,
    holds: bool,
    support_session: bool,
) -> bool {
    bundle()
        .and_then(|b| {
            b.decide(
                actor,
                org,
                &[],
                resource_org,
                &[
                    ("holds", Fact::Bool(holds)),
                    ("support_session", Fact::Bool(support_session)),
                ],
            )
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_holder_of_the_same_tenant_outside_a_support_session_asks() {
        assert!(decide("u", "o", "o", true, false));
        assert!(!decide("u", "o", "foreign", true, false));
        assert!(!decide("u", "o", "o", false, false));
        assert!(!decide("u", "o", "o", true, true));
        assert!(bundle().unwrap().decide("u", "o", &[], "o", &[]).is_err());
    }
}
