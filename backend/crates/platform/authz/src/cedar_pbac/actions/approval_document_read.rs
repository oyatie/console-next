// SPDX-License-Identifier: LicenseRef-Proprietary
//! Record visibility is the union of source-authorized inbox memberships.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;

const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action approval_document_read appliesTo { principal: [Subject], resource: [Resource],
 context: { "visible": Bool } };"#;
const POLICIES: &str = r#"permit(principal, action == Action::"approval_document_read", resource)
when { principal.org == resource.org && context.visible };"#;

pub fn decide(actor: &str, org: &str, resource_org: &str, visible: bool) -> Result<bool, String> {
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    BUNDLE
        .get_or_init(|| ActionBundle::compile("approval_document_read", SCHEMA, POLICIES))
        .as_ref()
        .map_err(Clone::clone)?
        .decide(
            actor,
            org,
            &[],
            resource_org,
            &[("visible", Fact::Bool(visible))],
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn membership_and_tenant_are_required_and_missing_facts_fail_closed() {
        assert_eq!(decide("u", "o", "o", true), Ok(true));
        assert_eq!(decide("u", "o", "o", false), Ok(false));
        assert_eq!(decide("u", "o", "foreign", true), Ok(false));
        let bundle = ActionBundle::compile("approval_document_read", SCHEMA, POLICIES).unwrap();
        assert!(bundle.decide("u", "o", &[], "o", &[]).is_err());
    }
}
