// SPDX-License-Identifier: LicenseRef-Proprietary
//! Permission is loaded for the subject's scope by visible::load_facts.
//! Requester = subject; contributor = filer. There is no sole-holder exception.
use super::super::action_schema::{ActionSchema, FactType, RequiredFact};
use super::super::facts::second_person::{
    ACTOR_CONTRIBUTED, ACTOR_HOLDS_PERMISSION, ACTOR_IS_REQUESTER,
};
use super::{ActionBundle, Fact};
use crate::Feature;
use std::sync::OnceLock;

const ACTION: &str = "privacy_request_decide";
const CEDAR_SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action privacy_request_decide appliesTo {
  principal: [Subject], resource: [Resource],
  context: {
    "actor_is_requester": Bool,
    "actor_contributed": Bool,
    "actor_holds_permission": Bool,
    "actor_decided_original": Bool
  }
};"#;

/// Server-computed admission and SoD facts for deciding a privacy rights request.
#[derive(Debug, Clone, Copy)]
pub struct DecisionFacts {
    pub actor_is_requester: bool,
    pub actor_contributed: bool,
    pub actor_holds_permission: bool,
    pub actor_decided_original: bool,
}

fn bundle() -> Result<&'static ActionBundle, String> {
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    BUNDLE
        .get_or_init(|| ActionBundle::compile(ACTION, CEDAR_SCHEMA, SCHEMA.policies))
        .as_ref()
        .map_err(Clone::clone)
}

/// Evaluate `privacy_request_decide` with Cedar `@reason` diagnostics.
///
/// # Errors
/// Returns a compilation or evaluation error if the policy bundle or facts are invalid.
pub fn decide(
    user: &str,
    org: &str,
    target_org: &str,
    facts: DecisionFacts,
) -> Result<(bool, Vec<String>), String> {
    bundle()?.decide_with_reasons(
        user,
        org,
        &[],
        target_org,
        &[
            ("actor_is_requester", Fact::Bool(facts.actor_is_requester)),
            ("actor_contributed", Fact::Bool(facts.actor_contributed)),
            (
                "actor_holds_permission",
                Fact::Bool(facts.actor_holds_permission),
            ),
            (
                "actor_decided_original",
                Fact::Bool(facts.actor_decided_original),
            ),
        ],
    )
}

pub const SCHEMA: ActionSchema = ActionSchema {
    denial_codes: &[],
    feature: Feature::PrivacyRequestDecide,
    version: "2026-10-privacy-request-decide-v1",
    facts: &[
        ACTOR_IS_REQUESTER,
        ACTOR_CONTRIBUTED,
        ACTOR_HOLDS_PERMISSION,
        RequiredFact {
            name: "actor_decided_original",
            ty: FactType::Bool,
        },
    ],
    policies: r#"@reason("own_request_forbidden")
forbid(principal, action == Action::"privacy_request_decide", resource)
when { context.actor_is_requester || context.actor_contributed };
@reason("objection_same_decider")
forbid(principal, action == Action::"privacy_request_decide", resource)
when { context.actor_decided_original };
permit(principal, action == Action::"privacy_request_decide", resource)
when { principal.org == resource.org && context.actor_holds_permission };"#,
};
