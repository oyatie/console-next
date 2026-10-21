// SPDX-License-Identifier: LicenseRef-Proprietary
//! Certificate doors: each action requires a server-computed grant and tenant equality.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;

pub const ACTIONS: &[&str] = &[
    "certificate_read",
    "certificate_issue",
    "certificate_void",
    "certificate_reissue",
    "certificate_settings_read",
    "certificate_settings_manage",
];
fn bundles() -> Result<&'static [ActionBundle], String> {
    static BUNDLES: OnceLock<Result<Vec<ActionBundle>, String>> = OnceLock::new();
    BUNDLES.get_or_init(|| ACTIONS.iter().map(|&action| {
        let schema=format!(r#"entity Subject = {{ "org": String, "roles": Set<String> }};
entity Resource = {{ "org": String }};
action {action} appliesTo {{ principal: [Subject], resource: [Resource], context: {{ "actor_holds_permission": Bool }} }};"#);
        let policy=format!(r#"permit(principal, action == Action::"{action}", resource) when {{ principal.org == resource.org && context.actor_holds_permission }};"#);
        ActionBundle::compile(action,&schema,&policy)
    }).collect()).as_ref().map(Vec::as_slice).map_err(Clone::clone)
}
/// Missing actions, invalid schemas and evaluation errors fail closed.
pub fn decide(
    action: &str,
    actor: &str,
    org: &str,
    resource_org: &str,
    holds: bool,
) -> Result<bool, String> {
    let index = ACTIONS
        .iter()
        .position(|a| *a == action)
        .ok_or_else(|| "unknown certificate action".to_owned())?;
    bundles()?[index].decide(
        actor,
        org,
        &[],
        resource_org,
        &[("actor_holds_permission", Fact::Bool(holds))],
    )
}
#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    #[test]
    fn each_door_refuses_another_tenant_lower_grant_and_missing_fact() {
        for (i, action) in ACTIONS.iter().enumerate() {
            assert_eq!(decide(action, "u", "o", "o", true), Ok(true));
            assert_eq!(decide(action, "u", "o", "other", true), Ok(false));
            assert_eq!(decide(action, "u", "o", "o", false), Ok(false));
            assert!(
                bundles().unwrap()[i]
                    .decide("u", "o", &[], "o", &[])
                    .is_err()
            );
        }
        assert!(decide("unknown", "u", "o", "o", true).is_err());
    }
}
