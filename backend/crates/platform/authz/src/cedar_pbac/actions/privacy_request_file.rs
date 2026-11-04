// SPDX-License-Identifier: LicenseRef-Proprietary
//! Session identity suffices to file; HR data requires the actor's linked employee.
use super::super::action_schema::{ActionSchema, FactType, RequiredFact};
use super::super::facts::second_person::ACTOR_IS_REQUESTER;
use crate::Feature;

pub const SCHEMA: ActionSchema = ActionSchema {
    denial_codes: &[],
    feature: Feature::PrivacyRequestFile,
    version: "2026-10-privacy-request-file-v1",
    facts: &[
        ACTOR_IS_REQUESTER,
        RequiredFact {
            name: "is_hr",
            ty: FactType::Bool,
        },
        RequiredFact {
            name: "has_employee",
            ty: FactType::Bool,
        },
    ],
    policies: r#"permit(principal, action == Action::"privacy_request_file", resource)
when {
  principal.org == resource.org && context.actor_is_requester &&
  (!context.is_hr || context.has_employee)
};"#,
};

/// Evaluate the registered filing policy using facts from the canonical loader.
pub(crate) fn decide(
    actor: &str,
    org: &str,
    own: bool,
    hr: bool,
    linked: bool,
) -> Result<bool, String> {
    use super::{ActionBundle, Fact};
    use std::sync::OnceLock;
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    const SHAPE: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action privacy_request_file appliesTo { principal: [Subject], resource: [Resource],
context: { "actor_is_requester": Bool, "is_hr": Bool, "has_employee": Bool } };"#;
    BUNDLE
        .get_or_init(|| ActionBundle::compile("privacy_request_file", SHAPE, SCHEMA.policies))
        .as_ref()
        .map_err(Clone::clone)?
        .decide(
            actor,
            org,
            &[],
            org,
            &[
                ("actor_is_requester", Fact::Bool(own)),
                ("is_hr", Fact::Bool(hr)),
                ("has_employee", Fact::Bool(linked)),
            ],
        )
}

pub(crate) fn read(actor: &str, org: &str, own: bool) -> Result<bool, String> {
    use super::{ActionBundle, Fact};
    use std::sync::OnceLock;
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    const SHAPE: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action privacy_request_read appliesTo { principal: [Subject], resource: [Resource], context: { "subject_is_self": Bool } };"#;
    const POLICY: &str = r#"permit(principal, action == Action::"privacy_request_read", resource)
when { principal.org == resource.org && context.subject_is_self };"#;
    BUNDLE
        .get_or_init(|| ActionBundle::compile("privacy_request_read", SHAPE, POLICY))
        .as_ref()
        .map_err(Clone::clone)?
        .decide(
            actor,
            org,
            &[],
            org,
            &[("subject_is_self", Fact::Bool(own))],
        )
}
