// SPDX-License-Identifier: LicenseRef-Proprietary
//! Case B eligibility only; this permit never authorizes a business write.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;

const ACTION: &str = "org_change_sole_holder";
const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action org_change_sole_holder appliesTo {
  principal: [Subject], resource: [Resource],
  context: { "holds_permission": Bool, "identities_bound": Bool,
             "requires_exception": Bool, "routed": Bool, "pending": Bool,
             "other_holder": Bool, "sole_holder_allowed": Bool }
};"#;
const POLICIES: &str = r#"permit(principal, action == Action::"org_change_sole_holder", resource)
when { principal.org == resource.org && context.holds_permission && context.identities_bound &&
       context.requires_exception && context.routed && context.pending &&
       !context.other_holder && context.sole_holder_allowed };"#;

pub struct Facts {
    pub holds_permission: bool,
    pub identities_bound: bool,
    pub requires_exception: bool,
    pub routed: bool,
    pub pending: bool,
    pub other_holder: bool,
    pub sole_holder_allowed: bool,
}

/// Every fact is required; missing/mistyped facts and evaluation errors deny.
pub fn decide(actor: &str, org: &str, resource_org: &str, f: Facts) -> Result<bool, String> {
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
                ("holds_permission", Fact::Bool(f.holds_permission)),
                ("identities_bound", Fact::Bool(f.identities_bound)),
                ("requires_exception", Fact::Bool(f.requires_exception)),
                ("routed", Fact::Bool(f.routed)),
                ("pending", Fact::Bool(f.pending)),
                ("other_holder", Fact::Bool(f.other_holder)),
                ("sole_holder_allowed", Fact::Bool(f.sole_holder_allowed)),
            ],
        )
}
