// SPDX-License-Identifier: LicenseRef-Proprietary
//! Match existing account data, or require full-name confirmation when no record matches.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;

const ACTION: &str = "account_link_record";
const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action account_link_record appliesTo { principal: [Subject], resource: [Resource],
  context: { "matches_record": Bool, "any_match": Bool, "name_confirmed": Bool }
};"#;
const POLICIES: &str = r#"permit(principal, action == Action::"account_link_record", resource)
when { principal.org == resource.org &&
       (context.matches_record || (!context.any_match && context.name_confirmed)) };"#;

#[derive(Clone, Copy, serde::Serialize)]
pub struct Facts {
    pub matches_record: bool,
    pub any_match: bool,
    pub name_confirmed: bool,
}

/// Missing facts and evaluation errors fail closed.
pub fn decide(actor: &str, org: &str, resource_org: &str, facts: Facts) -> Result<bool, String> {
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
                ("matches_record", Fact::Bool(facts.matches_record)),
                ("any_match", Fact::Bool(facts.any_match)),
                ("name_confirmed", Fact::Bool(facts.name_confirmed)),
            ],
        )
}
