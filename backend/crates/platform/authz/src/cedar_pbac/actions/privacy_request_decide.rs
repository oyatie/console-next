// SPDX-License-Identifier: LicenseRef-Proprietary
//! Permission is loaded for the subject's scope by visible::load_facts.
//! Requester = subject; contributor = filer. There is no sole-holder exception.
use super::super::action_schema::{ActionSchema, FactType, RequiredFact};
use super::super::facts::second_person::{
    ACTOR_CONTRIBUTED, ACTOR_HOLDS_PERMISSION, ACTOR_IS_REQUESTER,
};
use crate::Feature;

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
