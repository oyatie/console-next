// SPDX-License-Identifier: LicenseRef-Proprietary
//! Legacy read compatibility supplements the Cedar employee visibility filter.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;

const SCHEMA: &str = r#"entity Subject = { org: String, roles: Set<String> };
entity Resource = { org: String };
action leave_read appliesTo { principal: [Subject], resource: [Resource],
 context: { branch_member: Bool } };"#;
const POLICIES: &str = r#"permit(principal, action == Action::"leave_read", resource)
when { principal.org == resource.org && (
 principal.roles.contains("SUPER_ADMIN") || principal.roles.contains("EXECUTIVE") ||
 (principal.roles.contains("ADMIN") && context.branch_member)) };"#;

pub fn decide(actor: &str, org: &str, roles: &[&str], member: bool) -> Result<bool, String> {
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    BUNDLE
        .get_or_init(|| ActionBundle::compile("leave_read", SCHEMA, POLICIES))
        .as_ref()
        .map_err(Clone::clone)?
        .decide(
            actor,
            org,
            roles,
            org,
            &[("branch_member", Fact::Bool(member))],
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_read_roles_keep_their_scope() {
        for (role, member, allowed) in [
            ("MEMBER", true, false),
            ("ADMIN", false, false),
            ("ADMIN", true, true),
            ("EXECUTIVE", false, true),
            ("SUPER_ADMIN", false, true),
        ] {
            assert_eq!(decide("u", "o", &[role], member), Ok(allowed));
        }
    }
}
