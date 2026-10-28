// SPDX-License-Identifier: LicenseRef-Proprietary
//! One draft authority for create, edit, preflight, submit and cancellation.
use super::{ActionBundle, Fact};
use crate::{Feature, cedar_pbac::engine::generate_policies};
use std::sync::OnceLock;

/// Preserve role compatibility in Cedar alongside the scoped grant decision.
/// Only draft lifecycle actions are enrolled; unknown actions deny.
pub fn allowed(
    feature: Feature,
    actor: &str,
    org: &str,
    roles: &[String],
    holds_permission: bool,
) -> bool {
    static DRAFT: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    static APPLY: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    let slot = match feature {
        Feature::OrgChangeDraft => &DRAFT,
        Feature::OrgChangeApply => &APPLY,
        _ => return false,
    };
    let action = feature.as_str();
    let bundle = slot.get_or_init(|| {
        let schema = format!(
            r#"entity Subject = {{ org: String, roles: Set<String> }};
entity Resource = {{ org: String }};
action {action} appliesTo {{ principal: [Subject], resource: [Resource],
 context: {{ holds_permission: Bool }} }};"#
        );
        let policies = format!(
            r#"{}
permit(principal, action == Action::"{action}", resource) when {{ context.holds_permission }};
forbid(principal, action, resource) unless {{ principal.org == resource.org }};"#,
            generate_policies(feature)
        );
        ActionBundle::compile(action, &schema, &policies)
    });
    bundle.as_ref().is_ok_and(|bundle| {
        bundle
            .decide(
                actor,
                org,
                &roles.iter().map(String::as_str).collect::<Vec<_>>(),
                org,
                &[("holds_permission", Fact::Bool(holds_permission))],
            )
            .unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PermissionLevel, Role, permission_for};

    #[test]
    fn legacy_roles_and_scoped_grants_share_the_same_cedar_actions() {
        for feature in [Feature::OrgChangeDraft, Feature::OrgChangeApply] {
            for role in Role::ALL {
                let roles = vec![role.as_str().to_owned()];
                assert_eq!(
                    allowed(feature, "u", "o", &roles, false),
                    permission_for(role, feature) == PermissionLevel::Allow
                );
                assert!(allowed(feature, "u", "o", &roles, true));
            }
            assert!(!allowed(feature, "u", "o", &[], false));
            assert!(allowed(feature, "u", "o", &[], true));
        }
        for feature in [
            Feature::OrgChangeRead,
            Feature::RegionManage,
            Feature::BranchManage,
        ] {
            assert!(!allowed(feature, "u", "o", &[], true));
        }
    }
}
