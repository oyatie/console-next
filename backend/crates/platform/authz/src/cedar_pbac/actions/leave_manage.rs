// SPDX-License-Identifier: LicenseRef-Proprietary
//! Tenant grants own leave admission; live built-in roles remain compatible during transition.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;

const ACTION: &str = "leave_manage";
const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action leave_manage appliesTo { principal: [Subject], resource: [Resource],
 context: { "manages_directory": Bool, "branch_member": Bool } };"#;
const POLICIES: &str = r#"permit(principal, action == Action::"leave_manage", resource)
when { principal.org == resource.org && (context.manages_directory ||
 principal.roles.contains("SUPER_ADMIN") ||
 (principal.roles.contains("ADMIN") && context.branch_member)) };"#;

pub fn decide(
    actor: &str,
    org: &str,
    roles: &[&str],
    manages: bool,
    member: bool,
) -> Result<bool, String> {
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    BUNDLE
        .get_or_init(|| ActionBundle::compile(ACTION, SCHEMA, POLICIES))
        .as_ref()
        .map_err(Clone::clone)?
        .decide(
            actor,
            org,
            roles,
            org,
            &[
                ("manages_directory", Fact::Bool(manages)),
                ("branch_member", Fact::Bool(member)),
            ],
        )
}
